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

const storageSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().trim().regex(/^sb_secret_[a-zA-Z0-9_-]+$/).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/).optional(),
  SUPABASE_AVATAR_BUCKET: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).default("avatars"),
}).refine((config) => !!(config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY), {
  path: ["SUPABASE_SECRET_KEY"], message: "A Supabase server key is required",
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
  const storageEnv = Object.fromEntries(Object.keys(storageSchema.shape).map((key) => [key, env[key]?.trim() || undefined]));
  const storage = Object.values(storageEnv).some(Boolean) ? storageSchema.parse(storageEnv) : undefined;
  if (storage) {
    const url = new URL(storage.SUPABASE_URL);
    const local = config.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("SUPABASE_URL must be the project origin using HTTPS, or an HTTP loopback origin outside production");
    }
    storage.SUPABASE_URL = url.origin;
  }
  return { ...config, storage };
}
export type Config = ReturnType<typeof readConfig>;
