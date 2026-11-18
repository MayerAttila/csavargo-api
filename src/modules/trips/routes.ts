import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Auth } from "../auth/auth.js";
import { requireSession, unauthorizedSchema } from "../auth/routes.js";

const place = z.strictObject({
  id: z.string().min(1).max(512),
  label: z.string().trim().min(1).max(200),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  address: z.string().max(512).optional(),
  locality: z.string().max(200).optional(),
});
const plan = z.strictObject({
  destination: place,
  start: z.iso.date(),
  end: z.iso.date(),
  days: z.array(z.strictObject({ date: z.iso.date(), stops: z.array(place).min(1) })),
}).refine(({ start, end, days }) => start <= end
  && new Set(days.map(({ date }) => date)).size === days.length
  && days.every(({ date, stops }) => start <= date && date <= end && new Set(stops.map(({ id }) => id)).size === stops.length),
{ message: "Invalid trip calendar" });
const version = z.number().int().min(0).max(2_147_483_647);
const response = z.object({ version, plan: plan.nullable() });
const error = z.object({ code: z.string(), message: z.string() });
const unavailable = { code: "TRIP_UNAVAILABLE", message: "A terv jelenleg nem érhető el." };
const security = [{ sessionCookie: [] }];

export function registerTripRoutes(app: FastifyInstance, auth: Auth | undefined, prisma: PrismaClient | undefined, publicUrl: string) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get("/api/trip-plan", {
    schema: { operationId: "getTripPlan", tags: ["Trips"], security, response: { 200: response, 401: unauthorizedSchema, 503: error } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const saved = await prisma.tripPlan.findUnique({ where: { userId: session.user.id } });
    return saved ? { version: saved.version, plan: plan.parse(saved.plan) } : { version: 0, plan: null };
  });

  routes.put("/api/trip-plan", {
    schema: {
      operationId: "saveTripPlan", tags: ["Trips"], security, body: z.strictObject({ version: version.max(2_147_483_646), plan }),
      response: { 200: response, 401: unauthorizedSchema, 403: error, 409: error, 503: error },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth || !prisma) return reply.code(503).send(unavailable);
    if (request.headers.origin && request.headers.origin !== new URL(publicUrl).origin) {
      return reply.code(403).send({ code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." });
    }
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const userId = session.user.id;
    const input = request.body;
    const nextVersion = input.version + 1;
    const data = { version: nextVersion, plan: input.plan };
    const result = input.version === 0
      ? await prisma.tripPlan.createMany({ data: { userId, ...data }, skipDuplicates: true })
      : await prisma.tripPlan.updateMany({ where: { userId, version: input.version }, data });
    if (!result.count) {
      const saved = await prisma.tripPlan.findUnique({ where: { userId } });
      if (saved && isDeepStrictEqual(plan.parse(saved.plan), input.plan)) return { version: saved.version, plan: input.plan };
      return reply.code(409).send({ code: "TRIP_CONFLICT", message: "A tervet időközben máshol módosították." });
    }
    return data;
  });
}
