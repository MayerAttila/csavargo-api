import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Auth } from "./auth.js";
import { avatarBytes, avatarObjectKey, avatarSource, normalizeAvatar } from "./avatar.js";
import { AvatarStorageResponseError, type AvatarStore } from "./avatar-store.js";
import { consumeMinuteLimit } from "./rate-limit.js";
import { meSchema, requireSession, unauthorizedSchema } from "./routes.js";

const profileInput = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  image: z.string().max(300_000).nullable().optional(),
}).refine(({ name, image }) => name !== undefined || image !== undefined);
const apiError = z.object({ code: z.string(), message: z.string() });
const forbidden = { code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." };
const missing = { code: "AVATAR_NOT_FOUND", message: "A profilkép nem található." };
const unavailable = { code: "AVATAR_UNAVAILABLE", message: "A profilképek átmenetileg nem érhetők el. Próbáld újra később." };
const unauthorized = { code: "UNAUTHORIZED" as const, message: "A folytatáshoz jelentkezz be." };
const conflict = { code: "PROFILE_CHANGED", message: "A profil időközben megváltozott. Frissítsd az oldalt, majd próbáld újra." };
const shared = { tags: ["Auth"], security: [{ sessionCookie: [] }] };
const uploadGracePeriod = 15 * 60_000;

export function registerProfileRoutes(app: FastifyInstance, auth: Auth | undefined, prisma: PrismaClient | undefined,
  publicUrl: string, store?: AvatarStore, scheduleCleanup?: () => void) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const origin = new URL(publicUrl).origin;

  routes.patch("/api/me/profile", {
    bodyLimit: 310_000,
    schema: { ...shared, operationId: "editProfile", body: profileInput,
      response: { 200: meSchema, 400: apiError, 401: unauthorizedSchema, 403: apiError, 409: apiError, 429: apiError, 503: apiError } },
    onSend: async (request, reply, payload) => {
      if (reply.statusCode >= 400 && typeof payload === "string") {
        let code: string | undefined;
        try {
          const error = JSON.parse(payload) as { code?: unknown };
          if (typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)) code = error.code;
        } catch {
          // Fall back to the status for non-JSON errors.
        }
        request.log.warn({ event: "profile_save_rejected", status: reply.statusCode, code }, "Profile save rejected");
      }
      return payload;
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(401).send(unauthorized);
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(forbidden);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const { id, image: previousImage } = session.user;
    const { name, image } = request.body;
    const previousKey = avatarObjectKey(previousImage);
    if (image !== undefined && previousKey && !store) return reply.code(503).send(unavailable);
    if (!await consumeMinuteLimit(prisma, `profile-update:${id}`, 10)) {
      return reply.code(429).header("retry-after", "60").send({ code: "TOO_MANY_REQUESTS", message: "Túl sok próbálkozás. Próbáld újra egy perc múlva." });
    }

    let nextImage;
    try {
      nextImage = await normalizeAvatar(image);
    } catch {
      return reply.code(400).send({ code: "INVALID_AVATAR", message: "Érvénytelen profilkép." });
    }

    let staged: { key: string; availableAt: Date } | undefined;
    if (nextImage && store) {
      const key = `avatars/${randomUUID()}.webp`;
      staged = { key, availableAt: new Date(Date.now() + uploadGracePeriod) };
      // Keep a cleanup record even if the process stops after writing the object.
      await prisma.avatarCleanup.create({ data: staged });
      try {
        await store.put(key, avatarBytes(nextImage));
      } catch (error) {
        const upstreamStatus = error instanceof AvatarStorageResponseError ? error.status : undefined;
        request.log.warn({ event: "avatar_put_failed", upstreamStatus }, "Profile image could not be uploaded");
        return reply.code(503).send(unavailable);
      }
      nextImage = `supabase:${key}`;
    }

    const [updated] = await prisma.$transaction(async (tx) => {
      if (staged) {
        const held = await tx.avatarCleanup.deleteMany({ where: { ...staged, AND: { availableAt: { gt: new Date() } } } });
        if (!held.count) return [];
      }
      const users = await tx.user.updateManyAndReturn({
        where: { id, ...(image !== undefined && { image: previousImage ?? null }) },
        data: { name, image: nextImage },
        select: { id: true, name: true, email: true, emailVerified: true, image: true },
      });
      if (users.length && previousKey && image !== undefined) {
        await tx.avatarCleanup.create({ data: { key: previousKey, availableAt: new Date() } });
      } else if (!users.length && staged) {
        await tx.avatarCleanup.create({ data: { key: staged.key, availableAt: new Date() } });
      }
      return users;
    });
    scheduleCleanup?.();
    if (!updated) return reply.code(409).send(conflict);
    return { user: { ...updated, image: avatarSource(updated.image) } };
  });

  routes.get("/api/me/avatar/:version", {
    schema: { ...shared, operationId: "getProfileAvatar", params: z.object({ version: z.uuid() }),
      response: { 200: z.any().meta({ content: { "image/webp": { schema: { type: "string", format: "binary" } } } }),
        401: unauthorizedSchema, 404: apiError, 503: apiError } },
  }, async (request, reply) => {
    reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff");
    if (!auth) return reply.code(401).send(unauthorized);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const key = avatarObjectKey(session.user.image);
    if (!key || key !== `avatars/${request.params.version}.webp`) return reply.code(404).send(missing);
    if (!store) return reply.code(503).send(unavailable);
    try {
      const body = await store.get(key);
      if (!body) return reply.code(404).send(missing);
      return reply.type("image/webp").send(body);
    } catch (error) {
      const upstreamStatus = error instanceof AvatarStorageResponseError ? error.status : undefined;
      request.log.warn({ event: "avatar_get_failed", upstreamStatus }, "Profile image could not be loaded");
      return reply.code(503).send(unavailable);
    }
  });
}
