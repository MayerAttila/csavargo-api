import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Auth } from "../auth/auth.js";
import { requireSession, unauthorizedSchema } from "../auth/routes.js";
import { createDestinationCoverLookup, destinationCover } from "./destination-cover.js";

const place = z.strictObject({
  id: z.string().min(1).max(512),
  label: z.string().trim().min(1).max(200),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  address: z.string().max(512).optional(),
  locality: z.string().max(200).optional(),
});
const travelLeg = z.strictObject({
  mode: z.enum(["plane", "train", "bus", "car", "boat", "other"]).optional(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
}).refine(({ mode, time }) => mode !== undefined || time !== undefined, { message: "Empty trip travel leg" });

export const plan = z.strictObject({
  destination: place,
  lodging: place.optional(),
  arrival: travelLeg.optional(),
  departure: travelLeg.optional(),
  start: z.iso.date(),
  end: z.iso.date(),
  days: z.array(z.strictObject({ date: z.iso.date(), stops: z.array(place).min(1) })),
}).refine(({ start, end, days }) => start <= end
  && new Set(days.map(({ date }) => date)).size === days.length
  && days.every(({ date, stops }) => start <= date && date <= end && new Set(stops.map(({ id }) => id)).size === stops.length),
{ message: "Invalid trip calendar" });
const version = z.number().int().min(1).max(2_147_483_647);
const slug = z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const name = z.string().trim().min(1).max(200);
const trip = z.object({ slug, name, version, plan });
const summary = z.object({
  slug, name, destination: z.string(), start: z.iso.date(), end: z.iso.date(),
  stopCount: z.number().int().nonnegative(), companionCount: z.number().int().nonnegative(),
});
const params = z.object({ slug });
const create = z.strictObject({ id: z.uuid(), name: name.optional(), destination: place, start: z.iso.date(), end: z.iso.date() })
  .refine(({ start, end }) => start <= end, { message: "Invalid trip calendar" });
const error = z.object({ code: z.string(), message: z.string() });
const unavailable = { code: "TRIP_UNAVAILABLE", message: "Az utazás jelenleg nem érhető el." };
const notFound = { code: "TRIP_NOT_FOUND", message: "Az utazás nem található." };
const invalidOrigin = { code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." };
const conflict = { code: "TRIP_CONFLICT", message: "Az utazást időközben máshol módosították." };
const security = [{ sessionCookie: [] }];

function slugBase(label: string, start: string) {
  const segment = label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, 64).replace(/^-+|-+$/g, "");
  return `${segment || "utazas"}-${start.slice(0, 7)}`;
}

function tripDetails(row: { slug: string; name: string; version: number; plan: unknown }) {
  return { slug: row.slug, name: row.name, version: row.version, plan: plan.parse(row.plan) };
}

export function registerTripRoutes(app: FastifyInstance, auth: Auth | undefined, prisma: PrismaClient | undefined, publicUrl: string,
  lookupCover: ReturnType<typeof createDestinationCoverLookup>) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const origin = new URL(publicUrl).origin;

  routes.get("/api/trips", {
    schema: { operationId: "listTrips", tags: ["Trips"], security, response: { 200: z.array(summary), 401: unauthorizedSchema, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const rows = await prisma.tripPlan.findMany({ where: { userId: session.user.id }, select: {
      slug: true, name: true, plan: true, _count: { select: { invitations: { where: { acceptedAt: { not: null } } } } },
    } });
    return rows.map((row) => {
      const { destination, start, end, days } = plan.parse(row.plan);
      const stopCount = days.reduce((count, day) => count + day.stops.length, 0);
      return { slug: row.slug, name: row.name, destination: destination.label, start, end, stopCount, companionCount: row._count.invitations };
    }).sort((first, second) => first.start.localeCompare(second.start) || first.name.localeCompare(second.name, "hu"));
  });

  routes.post("/api/trips", {
    schema: {
      operationId: "createTrip", tags: ["Trips"], security, body: create,
      response: { 200: trip, 201: trip, 401: unauthorizedSchema, 403: error, 409: error, 503: error },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(invalidOrigin);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const userId = session.user.id;
    const { destination, start, end } = request.body;
    const id = request.body.id.toLowerCase();
    const tripName = request.body.name ?? destination.label;
    const base = slugBase(tripName, start);
    const data = { id, userId, name: tripName, version: 1, plan: { destination, start, end, days: [] } };

    for (const candidate of [base, `${base}-2`, `${base}-3`, `${base}-${id}`]) {
      const inserted = await prisma.tripPlan.createMany({ data: { ...data, slug: candidate }, skipDuplicates: true });
      if (inserted.count) return reply.code(201).send(tripDetails({ ...data, slug: candidate }));
      const previous = await prisma.tripPlan.findUnique({ where: { userId_id: { userId, id } } });
      if (previous) return reply.code(200).send(tripDetails(previous));
    }
    return reply.code(409).send(conflict);
  });

  routes.get("/api/trips/:slug", {
    schema: { operationId: "getTrip", tags: ["Trips"], security, params, response: { 200: trip, 401: unauthorizedSchema, 404: error, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const saved = await prisma.tripPlan.findUnique({ where: { userId_slug: { userId: session.user.id, slug: request.params.slug } } });
    return saved ? tripDetails(saved) : reply.code(404).send(notFound);
  });

  routes.get("/api/trips/:slug/cover", {
    schema: {
      operationId: "getTripCover", tags: ["Trips"], security, params,
      response: { 200: z.object({ cover: destinationCover.nullable() }), 401: unauthorizedSchema, 404: error, 503: error },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const saved = await prisma.tripPlan.findUnique({
      where: { userId_slug: { userId: session.user.id, slug: request.params.slug } },
      select: { plan: true },
    });
    if (!saved) return reply.code(404).send(notFound);
    return { cover: await lookupCover(plan.parse(saved.plan).destination) };
  });

  routes.put("/api/trips/:slug", {
    schema: {
      operationId: "saveTrip", tags: ["Trips"], security, params, body: z.strictObject({ name, version: version.max(2_147_483_646), plan }),
      response: { 200: trip, 401: unauthorizedSchema, 403: error, 404: error, 409: error, 503: error },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(invalidOrigin);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const where = { userId: session.user.id, slug: request.params.slug };
    const input = request.body;
    const data = { version: input.version + 1, plan: input.plan, name: input.name };
    const result = await prisma.tripPlan.updateMany({ where: { ...where, version: input.version }, data });
    if (result.count) return { slug: where.slug, ...data };

    const saved = await prisma.tripPlan.findUnique({ where: { userId_slug: where } });
    if (!saved) return reply.code(404).send(notFound);
    const current = tripDetails(saved);
    if (saved.name === input.name && isDeepStrictEqual(current.plan, input.plan)) return current;
    return reply.code(409).send(conflict);
  });
}
