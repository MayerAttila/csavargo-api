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
import { consumeAuthLimit } from "./modules/auth/rate-limit.js";

export async function buildApp(options: { config?: Config; mailer?: Mailer } = {}) {
  const config = options.config;
  const app = Fastify({
    trustProxy: config?.TRUSTED_PROXY ? config.TRUSTED_PROXY.split(",").map((item) => item.trim()) : false,
    logger: {
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
  let consumeLimit;
  if (config) {
    const { createPrisma } = await import("./lib/prisma.js");
    const prisma = createPrisma(config.DATABASE_URL);
    auth = createAuth(prisma, config, options.mailer ?? createMailer(config), app.log);
    consumeLimit = (ip: string) => consumeAuthLimit(prisma, ip);
    app.addHook("onClose", async () => { await prisma.$disconnect(); });
  }
  registerAuthRoutes(app, auth, config?.BETTER_AUTH_URL ?? "http://localhost:3000", consumeLimit);
  app.get("/health", {
    schema: { response: { 200: z.object({ status: z.string(), service: z.string() }) } },
  }, async () => ({ status: "ok", service: "csavargo-api" }));
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  return app;
}
