import Fastify from "fastify";
import cors from "@fastify/cors";

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  });
  app.get("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            service: { type: "string" },
          },
          required: ["status", "service"],
        },
      },
    },
  }, async () => ({ status: "ok", service: "csavargo-api" }));
  return app;
}
