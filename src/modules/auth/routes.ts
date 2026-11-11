import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Auth } from "./auth.js";

export const meSchema = z.object({ user: z.object({
  id: z.string(), name: z.string(), email: z.email(), emailVerified: z.boolean(),
}) });
export const unauthorizedSchema = z.object({ code: z.literal("UNAUTHORIZED"), message: z.string() });

export async function requireSession(auth: Auth, request: FastifyRequest, reply: FastifyReply) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers), query: { disableCookieCache: true } });
  if (!session) {
    await reply.code(401).send({ code: "UNAUTHORIZED", message: "A folytatáshoz jelentkezz be." });
    return null;
  }
  return session;
}

export function forwardAuthResponse(response: Response, reply: FastifyReply) {
  reply.code(response.status);
  response.headers.forEach((value, key) => { if (key.toLowerCase() !== "set-cookie") reply.header(key, value); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
  reply.header("cache-control", "no-store");
}

export function registerAuthRoutes(app: FastifyInstance, auth: Auth | undefined, publicUrl: string, consumeLimit?: (ip: string) => Promise<boolean>) {
  app.route({ method: ["GET", "POST"], url: "/api/auth/*", schema: { hide: true }, async handler(request, reply) {
    if (!auth) return reply.code(503).send({ code: "AUTH_UNAVAILABLE", message: "A bejelentkezési szolgáltatás jelenleg nem elérhető." });
    if (request.headers.origin && request.headers.origin !== new URL(publicUrl).origin) {
      return reply.code(403).send({ code: "INVALID_ORIGIN", message: "Nem engedélyezett kérési forrás." });
    }
    if (consumeLimit && !await consumeLimit(request.ip)) return reply.code(429).header("retry-after", "60").send({ message: "Túl sok próbálkozás. Próbáld újra egy perc múlva." });
    const headers = fromNodeHeaders(request.headers);
    // Ignore all client-supplied forwarding headers. Fastify resolves trusted proxies.
    ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"].forEach((name) => headers.delete(name));
    headers.set("x-csavargo-client-ip", request.ip);
    const url = new URL(request.raw.url ?? request.url, publicUrl);
    const response = await auth.handler(new Request(url, {
      method: request.method, headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    }));
    forwardAuthResponse(response, reply);
    return reply.send(response.body ? await response.text() : null);
  } });
  app.withTypeProvider<ZodTypeProvider>().get("/api/me", {
    schema: { operationId: "getMe", tags: ["Auth"], security: [{ sessionCookie: [] }], response: { 200: meSchema, 401: unauthorizedSchema } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!auth) return reply.code(401).send({ code: "UNAUTHORIZED" as const, message: "A folytatáshoz jelentkezz be." });
    const session = await requireSession(auth, request, reply);
    if (!session) return;
    const { id, name, email, emailVerified } = session.user;
    return { user: { id, name, email, emailVerified } };
  });
}
