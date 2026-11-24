import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Auth } from "../auth/auth.js";
import type { Mailer } from "../auth/mail.js";
import { avatarBytes, avatarContentSchema, avatarObjectKey, storedAvatar } from "../auth/avatar.js";
import { AvatarStorageResponseError, type AvatarStore } from "../auth/avatar-store.js";
import { consumeMinuteLimit } from "../auth/rate-limit.js";
import { requireSession, unauthorizedSchema } from "../auth/routes.js";

const entry = z.object({ id: z.uuid(), name: z.string() });
const count = z.int().nonnegative();
const acceptedEntry = entry.extend({
  image: z.string().optional(),
  stats: z.object({ ownedTrips: count, sharedTrips: count, companions: count }),
});
const lists = z.object({ accepted: z.array(acceptedEntry), incoming: z.array(entry), outgoing: z.array(entry) });
const error = z.object({ code: z.string(), message: z.string() });
const idParams = z.object({ id: z.uuid() });
const success = z.null();
const unavailable = { code: "COMPANIONS_UNAVAILABLE", message: "Az útitársak jelenleg nem érhetők el." };
const forbidden = { code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." };
const missing = { code: "COMPANION_NOT_FOUND", message: "Az útitárskapcsolat nem található." };
const missingAvatar = { code: "AVATAR_NOT_FOUND", message: "A profilkép nem található." };
const security = [{ sessionCookie: [] }];
const shared = { tags: ["Companions"], security };

function participant(userId: string) {
  return { OR: [{ firstId: userId }, { secondId: userId }] };
}

export function registerCompanionRoutes(app: FastifyInstance, auth: Auth | undefined, prisma: PrismaClient | undefined,
  publicUrl: string, mailer?: Mailer, avatarStore?: AvatarStore) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const origin = new URL(publicUrl).origin;

  routes.get("/api/companions", {
    schema: { ...shared, operationId: "listCompanions", response: { 200: lists, 401: unauthorizedSchema, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const userId = session.user.id;
    const rows = await prisma.companion.findMany({
      where: participant(userId),
      select: { id: true, firstId: true, secondId: true, requesterId: true, acceptedAt: true,
        first: { select: { name: true } }, second: { select: { name: true } } },
    });
    const acceptedIds = rows.filter(({ acceptedAt }) => acceptedAt).map(({ firstId, secondId }) => firstId === userId ? secondId : firstId);
    const [profiles, sharedTrips] = acceptedIds.length ? await Promise.all([
      prisma.user.findMany({
        where: { id: { in: acceptedIds } },
        select: { id: true, image: true, _count: { select: {
          tripPlans: true,
          companionFirst: { where: { acceptedAt: { not: null } } },
          companionSecond: { where: { acceptedAt: { not: null } } },
        } } },
      }),
      prisma.tripInvitation.groupBy({
        by: ["ownerId", "recipientId"],
        where: { acceptedAt: { not: null }, OR: [
          { ownerId: userId, recipientId: { in: acceptedIds } },
          { ownerId: { in: acceptedIds }, recipientId: userId },
        ] },
        _count: { _all: true },
      }),
    ]) : [[], []];
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    const sharedById = new Map<string, number>();
    for (const { ownerId, recipientId, _count } of sharedTrips) {
      const companionId = ownerId === userId ? recipientId : ownerId;
      sharedById.set(companionId, (sharedById.get(companionId) ?? 0) + _count._all);
    }
    const result: z.infer<typeof lists> = { accepted: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      const companion = row.firstId === userId ? row.second : row.first;
      const item = { id: row.id, name: companion.name };
      if (row.acceptedAt) {
        const companionId = row.firstId === userId ? row.secondId : row.firstId;
        const profile = profilesById.get(companionId);
        if (!profile) continue;
        const hasImage = avatarObjectKey(profile.image) || storedAvatar(profile.image);
        result.accepted.push({
          ...item,
          image: hasImage ? `/api/companions/${row.id}/avatar` : undefined,
          stats: {
            ownedTrips: profile._count.tripPlans,
            sharedTrips: sharedById.get(companionId) ?? 0,
            companions: profile._count.companionFirst + profile._count.companionSecond,
          },
        });
      } else {
        const pending = row.requesterId === userId ? result.outgoing : result.incoming;
        pending.push(item);
      }
    }
    for (const list of Object.values(result)) list.sort((a, b) => a.name.localeCompare(b.name, "hu") || a.id.localeCompare(b.id));
    return result;
  });

  routes.get("/api/companions/:id/avatar", {
    schema: { ...shared, operationId: "getCompanionAvatar", params: idParams,
      response: { 200: avatarContentSchema, 401: unauthorizedSchema, 404: error, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const userId = session.user.id;
    const row = await prisma.companion.findFirst({
      where: { id: request.params.id, acceptedAt: { not: null }, ...participant(userId) },
      select: { firstId: true, first: { select: { image: true } }, second: { select: { image: true } } },
    });
    if (!row) return reply.code(404).send(missingAvatar);
    const image = (row.firstId === userId ? row.second : row.first).image;
    const inline = storedAvatar(image);
    if (inline) return reply.type("image/webp").send(avatarBytes(inline));
    const key = avatarObjectKey(image);
    if (!key) return reply.code(404).send(missingAvatar);
    if (!avatarStore) return reply.code(503).send(unavailable);
    try {
      const body = await avatarStore.get(key);
      return body ? reply.type("image/webp").send(body) : reply.code(404).send(missingAvatar);
    } catch (failure) {
      const upstreamStatus = failure instanceof AvatarStorageResponseError ? failure.status : undefined;
      request.log.warn({ event: "companion_avatar_get_failed", upstreamStatus }, "Companion profile image could not be loaded");
      return reply.code(503).send(unavailable);
    }
  });

  routes.post("/api/companions", {
    schema: { ...shared, operationId: "requestCompanion",
      body: z.strictObject({ email: z.string().trim().max(254).pipe(z.email()) }),
      response: { 204: success, 400: error, 401: unauthorizedSchema, 403: error, 404: error, 409: error, 429: error, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(forbidden);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const requesterId = session.user.id;
    if (!await consumeMinuteLimit(prisma, `companions-request:${requesterId}`, 10)) {
      return reply.code(429).header("retry-after", "60").send({ code: "COMPANION_RATE_LIMIT", message: "Túl sok jelölés. Próbáld újra egy perc múlva." });
    }
    const user = await prisma.user.findUnique({ where: { email: request.body.email.toLowerCase() }, select: { id: true, email: true } });
    if (!user) return reply.code(404).send({ code: "COMPANION_EMAIL_NOT_FOUND", message: "Ehhez az e-mail-címhez nem tartozik fiók." });
    if (user.id === requesterId) return reply.code(400).send({ code: "COMPANION_SELF", message: "Saját magadat nem jelölheted meg útitársként." });

    const [firstId, secondId] = [requesterId, user.id].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const inserted = await prisma.companion.createMany({ data: { firstId, secondId, requesterId }, skipDuplicates: true });
    if (inserted.count) {
      try {
        await mailer?.({ kind: "companion-invite", to: user.email, requesterName: session.user.name,
          url: new URL("/belepes?folytatas=utitarsak", origin).href });
      } catch {
        request.log.error({ event: "companion_mail_failed" }, "Companion request saved but email delivery failed");
      }
      return reply.code(204).send(null);
    }
    const existing = await prisma.companion.findUnique({ where: { firstId_secondId: { firstId, secondId } },
      select: { requesterId: true, acceptedAt: true } });
    if (existing?.acceptedAt) return reply.code(409).send({ code: "COMPANION_ALREADY_ACCEPTED", message: "Már szerepel az útitársaid között." });
    if (existing?.requesterId === requesterId) return reply.code(204).send(null);
    return reply.code(409).send({ code: "COMPANION_REQUEST_CONFLICT", message: existing
      ? "Ez az útitárs már megjelölt téged. A beérkezett jelölések között elfogadhatod."
      : "A jelölés közben megváltozott. Próbáld újra." });
  });

  routes.post("/api/companions/:id/accept", {
    schema: { ...shared, operationId: "acceptCompanion", params: idParams,
      response: { 204: success, 401: unauthorizedSchema, 403: error, 404: error, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(forbidden);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const userId = session.user.id;
    const where = { id: request.params.id, ...participant(userId), requesterId: { not: userId } };
    const updated = await prisma.companion.updateMany({ where: { ...where, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (updated.count || await prisma.companion.findFirst({ where, select: { id: true } })) return reply.code(204).send(null);
    return reply.code(404).send(missing);
  });

  routes.delete("/api/companions/:id", {
    schema: { ...shared, operationId: "removeCompanion", params: idParams,
      response: { 204: success, 401: unauthorizedSchema, 403: error, 404: error, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(forbidden);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const deleted = await prisma.companion.deleteMany({ where: { id: request.params.id, ...participant(session.user.id) } });
    return deleted.count ? reply.code(204).send(null) : reply.code(404).send(missing);
  });
}
