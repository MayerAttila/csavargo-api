import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { AvatarStore } from "./avatar-store.js";

const retryDelay = 60_000;

export function createAvatarCleanup(prisma: PrismaClient, store: AvatarStore, log: FastifyBaseLogger) {
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let queued = false;

  async function drain() {
    const now = new Date();
    const jobs = await prisma.avatarCleanup.findMany({
      where: { availableAt: { lte: now } }, orderBy: { availableAt: "asc" }, take: 16,
    });
    await Promise.all(jobs.map(async ({ key, availableAt }) => {
      // Claim the row before touching the bucket. An upload commits only while its staging row is unchanged.
      const retryAt = new Date(Date.now() + retryDelay);
      const claim = await prisma.avatarCleanup.updateMany({ where: { key, availableAt }, data: { availableAt: retryAt } });
      if (!claim.count) return;
      try {
        await store.remove(key);
        await prisma.avatarCleanup.deleteMany({ where: { key, availableAt: retryAt } });
      } catch {
        log.warn({ event: "avatar_cleanup_retry" }, "Profile image cleanup will be retried");
      }
    }));
  }

  function run() {
    if (closed) return;
    if (active) {
      queued = true;
      return;
    }
    active = drain()
      .catch(() => { log.warn({ event: "avatar_cleanup_failed" }, "Profile image cleanup is temporarily unavailable"); })
      .finally(() => {
        active = undefined;
        if (queued) {
          queued = false;
          run();
        }
      });
  }

  return {
    run,
    start() {
      run();
      timer = setInterval(run, 30_000).unref();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
