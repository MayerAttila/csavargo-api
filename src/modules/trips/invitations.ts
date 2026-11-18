import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Auth } from "../auth/auth.js";
import type { Mailer } from "../auth/mail.js";
import { consumeMinuteLimit } from "../auth/rate-limit.js";
import { requireSession, unauthorizedSchema } from "../auth/routes.js";
import { plan } from "./routes.js";
import { destinationCover, type createDestinationCoverLookup } from "./destination-cover.js";

const id = z.uuid();
const person = z.object({ id, name: z.string() });
const member = person.extend({ accepted: z.boolean() });
const summary = member.extend({ owner: z.string(), destination: z.string(), start: z.iso.date(), end: z.iso.date(),
  stopCount: z.number().int().nonnegative(), companionCount: z.number().int().nonnegative() });
const sharedTrip = z.object({ name: z.string(), owner: z.string(), plan });
const error = z.object({ code: z.string(), message: z.string() });
const errors = { 401: unauthorizedSchema, 403: error, 404: error, 503: error };
const meta = { tags: ["Trip invitations"], security: [{ sessionCookie: [] }] };
const tripParams = z.object({ slug: z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) });
const invitationParams = z.object({ id });
const notFound = { code: "TRIP_INVITATION_NOT_FOUND", message: "Az utazás vagy a meghívás nem található." };
const noCompanion = { code: "TRIP_INVITATION_COMPANION_REQUIRED", message: "Csak elfogadott útitársat hívhatsz meg." };

export function registerTripInvitationRoutes(app: FastifyInstance, auth: Auth | undefined, prisma: PrismaClient | undefined, publicUrl: string,
  lookupCover: ReturnType<typeof createDestinationCoverLookup>, mailer?: Mailer) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const origin = new URL(publicUrl).origin;

  async function authorize(request: FastifyRequest, reply: FastifyReply) {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) {
      await reply.code(503).send({ code: "TRIP_INVITATIONS_UNAVAILABLE", message: "A meghívások jelenleg nem érhetők el." });
      return null;
    }
    if (request.method !== "GET" && request.headers.origin && request.headers.origin !== origin) {
      await reply.code(403).send({ code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." });
      return null;
    }
    const session = await requireSession(auth, request, reply);
    return session ? { db: prisma, user: session.user } : null;
  }

  const tripRoute = "/api/trips/:slug/invitations";
  const inboxRoute = "/api/trip-invitations";

  routes.get(tripRoute, {
    schema: { ...meta, operationId: "getTripInviteOptions", params: tripParams,
      response: { 200: z.object({ available: z.array(person), invitations: z.array(member) }), ...errors } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const { db, user } = context;
    const trip = await db.tripPlan.findUnique({
      where: { userId_slug: { userId: user.id, slug: request.params.slug } },
      select: { invitations: { select: { id: true, recipientId: true, acceptedAt: true, recipient: { select: { name: true } } } } },
    });
    if (!trip) return reply.code(404).send(notFound);
    const contacts = await db.companion.findMany({
      where: { acceptedAt: { not: null }, OR: [{ firstId: user.id }, { secondId: user.id }] },
      select: { id: true, firstId: true, secondId: true, first: { select: { name: true } }, second: { select: { name: true } } },
    });
    const invited = new Set(trip.invitations.map(({ recipientId }) => recipientId));
    const available = contacts.flatMap((contact) => {
      const first = contact.firstId === user.id;
      const recipientId = first ? contact.secondId : contact.firstId;
      return invited.has(recipientId) ? [] : [{ id: contact.id, name: (first ? contact.second : contact.first).name }];
    });
    return { available: available.sort((a, b) => a.name.localeCompare(b.name, "hu")),
      invitations: trip.invitations.map(({ id: inviteId, acceptedAt, recipient }) => ({ id: inviteId, name: recipient.name, accepted: Boolean(acceptedAt) })) };
  });

  routes.post(tripRoute, {
    schema: { ...meta, operationId: "sendTripInvitation", params: tripParams, body: z.strictObject({ companionId: id }),
      response: { 204: z.null(), ...errors, 429: error } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const { db, user } = context;
    const trip = await db.tripPlan.findUnique({
      where: { userId_slug: { userId: user.id, slug: request.params.slug } },
      select: { id: true, name: true },
    });
    if (!trip) return reply.code(404).send(notFound);
    const contact = await db.companion.findFirst({
      where: { id: request.body.companionId, acceptedAt: { not: null }, OR: [{ firstId: user.id }, { secondId: user.id }] },
      select: { firstId: true, first: { select: { id: true, email: true } }, second: { select: { id: true, email: true } } },
    });
    if (!contact) return reply.code(403).send(noCompanion);
    if (!await consumeMinuteLimit(db, `trip-invitations:${user.id}`, 10)) {
      return reply.code(429).header("retry-after", "60").send({ code: "TRIP_INVITATION_LIMIT", message: "Túl sok meghívás. Próbáld újra egy perc múlva." });
    }
    const recipient = contact.firstId === user.id ? contact.second : contact.first;
    const inserted = await db.tripInvitation.createMany({
      data: { ownerId: user.id, tripId: trip.id, recipientId: recipient.id }, skipDuplicates: true,
    });
    if (inserted.count) {
      try {
        await mailer?.({ kind: "trip-invite", to: recipient.email, requesterName: user.name, tripName: trip.name,
          url: new URL("/belepes?folytatas=utazasok", origin).href });
      } catch {
        request.log.error({ event: "trip_invitation_mail_failed" }, "Trip invitation saved but email delivery failed");
      }
    }
    return reply.code(204).send(null);
  });

  routes.get(inboxRoute, {
    schema: { ...meta, operationId: "listTripInvitations", response: { 200: z.array(summary), ...errors } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const rows = await context.db.tripInvitation.findMany({
      where: { recipientId: context.user.id },
      select: { id: true, acceptedAt: true, trip: { select: {
        name: true, plan: true, user: { select: { name: true } },
        _count: { select: { invitations: { where: { acceptedAt: { not: null } } } } },
      } } },
    });
    return rows.map(({ id: inviteId, acceptedAt, trip }) => {
      const { destination, start, end, days } = plan.parse(trip.plan);
      return { id: inviteId, accepted: Boolean(acceptedAt), name: trip.name, owner: trip.user.name, destination: destination.label, start, end,
        stopCount: acceptedAt ? days.reduce((count, day) => count + day.stops.length, 0) : 0,
        companionCount: acceptedAt ? trip._count.invitations : 0 };
    }).sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name, "hu"));
  });

  routes.get(`${inboxRoute}/:id/cover`, {
    schema: { ...meta, operationId: "getSharedTripCover", params: invitationParams,
      response: { 200: z.object({ cover: destinationCover.nullable() }), ...errors } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const row = await context.db.tripInvitation.findFirst({
      where: { id: request.params.id, recipientId: context.user.id, acceptedAt: { not: null } },
      select: { trip: { select: { plan: true } } },
    });
    if (!row) return reply.code(404).send(notFound);
    return { cover: await lookupCover(plan.parse(row.trip.plan).destination) };
  });

  routes.get(`${inboxRoute}/:id`, {
    schema: { ...meta, operationId: "getSharedTrip", params: invitationParams, response: { 200: sharedTrip, ...errors } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const row = await context.db.tripInvitation.findFirst({
      where: { id: request.params.id, recipientId: context.user.id, acceptedAt: { not: null } },
      select: { trip: { select: { name: true, plan: true, user: { select: { name: true } } } } },
    });
    if (!row) return reply.code(404).send(notFound);
    return { name: row.trip.name, owner: row.trip.user.name, plan: plan.parse(row.trip.plan) };
  });

  routes.post(`${inboxRoute}/:id/accept`, {
    schema: { ...meta, operationId: "acceptTripInvitation", params: invitationParams, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const where = { id: request.params.id, recipientId: context.user.id };
    const updated = await context.db.tripInvitation.updateMany({ where: { ...where, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (updated.count || await context.db.tripInvitation.findFirst({ where, select: { id: true } })) return reply.code(204).send(null);
    return reply.code(404).send(notFound);
  });

  routes.delete(`${inboxRoute}/:id`, {
    schema: { ...meta, operationId: "removeTripInvitation", params: invitationParams, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    const removed = await context.db.tripInvitation.deleteMany({
      where: { id: request.params.id, OR: [{ ownerId: context.user.id }, { recipientId: context.user.id }] },
    });
    return removed.count ? reply.code(204).send(null) : reply.code(404).send(notFound);
  });
}
