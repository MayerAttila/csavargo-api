import { buildApp } from "./app.js";

const app = await buildApp();
try {
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3001),
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
