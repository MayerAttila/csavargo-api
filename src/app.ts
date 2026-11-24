import { safeRequestUrl } from "./lib/logging.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "./lib/config.js";
import { createAuth } from "./modules/auth/auth.js";
import { createMailer, type Mailer } from "./modules/auth/mail.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerProfileRoutes } from "./modules/auth/profile-routes.js";
import { createAvatarStore, type AvatarStore } from "./modules/auth/avatar-store.js";
import { createAvatarCleanup } from "./modules/auth/avatar-cleanup.js";
import { consumeAuthLimit } from "./modules/auth/rate-limit.js";
import { registerTripRoutes } from "./modules/trips/routes.js";
import { registerCompanionRoutes } from "./modules/companions/routes.js";
import { registerTripInvitationRoutes } from "./modules/trips/invitations.js";
import { createDestinationCoverLookup } from "./modules/trips/destination-cover.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { Writable } from "node:stream";

export async function buildApp(options: { config?: Config; mailer?: Mailer; avatarStore?: AvatarStore; logStream?: Writable } = {}) {
  const config = options.config;
  const app = Fastify({
    trustProxy: config?.TRUSTED_PROXY ? config.TRUSTED_PROXY.split(",").map((item) => item.trim()) : false,
    logger: {
      ...(options.logStream && { stream: options.logStream }),
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie", "password", "token"],
      serializers: { req: (request) => ({ method: request.method, url: safeRequestUrl(request.url), hostname: request.hostname }) },
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, request, reply) => {
    const failure = error as { statusCode?: number };
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500 ? failure.statusCode : 500;
    app.log.error({ event: "request_failed", requestId: request.id, status }, "Request failed");
    void reply.code(status).send({ code: status === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
      message: status === 500 ? "A szerver átmenetileg nem érhető el. Próbáld újra később." : "Érvénytelen kérés." });
  });
  await app.register(cors, { origin: config?.WEB_ORIGIN ?? "http://localhost:3000", credentials: true });
  await app.register(swagger, {
    openapi: { info: { title: "Csavargó API", version: "1.0.0" }, components: { securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
    } } }, transform: jsonSchemaTransform,
  });
  let auth;
  let prisma: PrismaClient | undefined;
  let consumeLimit;
  let mailer: Mailer | undefined;
  const avatarStore = config?.storage ? options.avatarStore ?? createAvatarStore(config.storage) : undefined;
  let avatarCleanup: ReturnType<typeof createAvatarCleanup> | undefined;
  if (config) {
    const { createPrisma } = await import("./lib/prisma.js");
    const client = createPrisma(config.DATABASE_URL);
    prisma = client;
    mailer = options.mailer ?? createMailer(config);
    auth = createAuth(prisma, config, mailer, app.log);
    consumeLimit = (ip: string) => consumeAuthLimit(client, ip);
    if (avatarStore) {
      avatarCleanup = createAvatarCleanup(client, avatarStore, app.log);
      app.addHook("onReady", async () => { avatarCleanup?.start(); });
    }
    app.addHook("onClose", async () => {
      await avatarCleanup?.close();
      await client.$disconnect();
    });
  }
  registerAuthRoutes(app, auth, config?.BETTER_AUTH_URL ?? "http://localhost:3000", consumeLimit);
  const webOrigin = config?.WEB_ORIGIN ?? "http://localhost:3000";
  registerProfileRoutes(app, auth, prisma, webOrigin, avatarStore, avatarCleanup?.run);
  const lookupCover = createDestinationCoverLookup(webOrigin);
  registerTripRoutes(app, auth, prisma, webOrigin, lookupCover);
  registerCompanionRoutes(app, auth, prisma, webOrigin, mailer, avatarStore);
  registerTripInvitationRoutes(app, auth, prisma, webOrigin, lookupCover, mailer);
  app.get("/health", {
    schema: { response: { 200: z.object({ status: z.string(), service: z.string() }) } },
  }, async () => ({ status: "ok", service: "csavargo-api" }));
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  return app;
}
