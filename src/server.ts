import "dotenv/config";
import { buildApp } from "./app.js";
import { readConfig } from "./lib/config.js";

const app = await buildApp({ config: readConfig() });
try {
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3001),
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close(); });
}
