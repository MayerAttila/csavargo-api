import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Auth } from "../auth/auth.js";
import type { Mailer } from "../auth/mail.js";
import { consumeMinuteLimit } from "../auth/rate-limit.js";
import { requireSession, unauthorizedSchema } from "../auth/routes.js";

const entry = z.object({ id: z.uuid(), name: z.string() });
const lists = z.object({ accepted: z.array(entry), incoming: z.array(entry), outgoing: z.array(entry) });
const error = z.object({ code: z.string(), message: z.string() });
const idParams = z.object({ id: z.uuid() });
const success = z.null();
const unavailable = { code: "COMPANIONS_UNAVAILABLE", message: "Az útitársak jelenleg nem érhetők el." };
const forbidden = { code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." };
const missing = { code: "COMPANION_NOT_FOUND", message: "Az útitárskapcsolat nem található." };
const security = [{ sessionCookie: [] }];
const shared = { tags: ["Companions"], security };

function participant(userId: string) {
  return { OR: [{ firstId: userId }, { secondId: userId }] };
}

export function registerCompanionRoutes(app: FastifyInstance, auth: Auth | undefined, prisma: PrismaClient | undefined, publicUrl: string, mailer?: Mailer) {
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
      select: { id: true, firstId: true, requesterId: true, acceptedAt: true,
        first: { select: { name: true } }, second: { select: { name: true } } },
    });
    const result: z.infer<typeof lists> = { accepted: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      const list = row.acceptedAt ? result.accepted : row.requesterId === userId ? result.outgoing : result.incoming;
      list.push({ id: row.id, name: (row.firstId === userId ? row.second : row.first).name });
    }
    for (const list of Object.values(result)) list.sort((a, b) => a.name.localeCompare(b.name, "hu") || a.id.localeCompare(b.id));
    return result;
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
