import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Config } from "../../lib/config.js";
import type { Mailer } from "./mail.js";
import { normalizeAvatar } from "./avatar.js";

function normalizeUserName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100) throw new APIError("BAD_REQUEST", { code: "INVALID_NAME", message: "Adj meg egy 1–100 karakteres nevet." });
  return name;
}

export function createAuth(prisma: PrismaClient, config: Config, sendMail: Mailer, log: FastifyBaseLogger) {
  const deliver = async (to: string, url: string, kind: "verification" | "reset") => {
    try { await sendMail({ to, url, kind }); }
    catch { log.error({ event: "auth_mail_failed", kind }, "Auth email delivery failed; user can request another email"); }
  };
  async function imageFromAuth(image: string | null | undefined) {
    if (config.storage && image !== undefined) {
      throw new APIError("BAD_REQUEST", { code: "INVALID_AVATAR", message: "A profilképet a profiloldalon módosíthatod." });
    }
    return normalizeAvatar(image);
  }
  return betterAuth({
    appName: "Csavargó",
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    logger: { log(level) {
      const severity = level === "error" ? "error" : level === "warn" ? "warn" : "info";
      log[severity]({ event: "auth_library_message", level }, "Authentication library message");
    } },
    trustedOrigins: [config.WEB_ORIGIN],
    database: prismaAdapter(prisma, { provider: "postgresql", transaction: true }),
    emailAndPassword: {
      enabled: true, autoSignIn: true, requireEmailVerification: false,
      minPasswordLength: 8, maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => { await deliver(user.email, url, "reset"); },
    },
    emailVerification: {
      sendOnSignUp: true, expiresIn: 86400, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        const link = new URL(url);
        link.searchParams.set("callbackURL", `${config.WEB_ORIGIN}/email-megerosites`);
        await deliver(user.email, link.toString(), "verification");
      },
    },
    session: { expiresIn: 604800, updateAge: 86400, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: config.NODE_ENV === "production",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production" },
      ipAddress: { ipAddressHeaders: ["x-csavargo-client-ip"] },
    },
    rateLimit: {
      enabled: true, storage: "database", window: 60, max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 5 },
        "/update-user": { window: 60, max: 10 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: { before: async (user) => ({
          data: { ...user, name: normalizeUserName(user.name), image: await imageFromAuth(user.image ?? undefined) },
        }) },
        update: { before: async (user) => {
          const data = { ...user };
          if (data.name !== undefined) data.name = normalizeUserName(data.name);
          if (data.image !== undefined) data.image = await imageFromAuth(data.image);
          return { data };
        } },
      },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
