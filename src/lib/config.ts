import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  TRUSTED_PROXY: z.string().optional(),
  MAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
  MAIL_FROM: z.string().default("Csavargó <noreply@csavargo.local>"),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  RESEND_API_KEY: z.string().optional(),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production") {
    if (!config.BETTER_AUTH_URL.startsWith("https://") || !config.WEB_ORIGIN.startsWith("https://")) {
      throw new Error("Production auth requires HTTPS");
    }
    if (config.MAIL_PROVIDER !== "resend" || !config.RESEND_API_KEY) {
      throw new Error("Production requires Resend credentials");
    }
  }
  return config;
}
export type Config = ReturnType<typeof readConfig>;
