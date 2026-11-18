import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/lib/config.js";
import { createPrisma } from "../src/lib/prisma.js";
import { createAuth } from "../src/modules/auth/auth.js";
import { consumeAuthLimit } from "../src/modules/auth/rate-limit.js";
import type { AppMail } from "../src/modules/auth/mail.js";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("auth integration (isolated PostgreSQL)", () => {
  let app: FastifyInstance;
  const prisma = createPrisma(databaseUrl ?? "postgresql://localhost/unused");
  const config = readConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/unused_test", BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters", BETTER_AUTH_URL: "http://localhost:3000", WEB_ORIGIN: "http://localhost:3000" });
  const mails: AppMail[] = [];
  let failedCompanionAddress: string | undefined;
  const emails: string[] = [];
  let sequence = 0;
  const email = () => { const value = `${randomUUID()}@example.com`; emails.push(value); return value; };
  const password = "Csavargo-test-password-123";
  const request = (path: string, body?: Record<string, unknown>, cookie?: string, ip = `192.0.2.${++sequence % 250 + 1}`) => app.inject({
    method: body ? "POST" : "GET", url: `/api/auth${path}`, remoteAddress: ip,
    headers: { origin: config.WEB_ORIGIN, ...(cookie ? { cookie } : {}) }, ...(body ? { payload: body } : {}),
  });
  const cookies = (response: Awaited<ReturnType<typeof app.inject>>) => response.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  async function signup() {
    const address = email();
    const response = await request("/sign-up/email", { name: "Teszt Utazó", email: address, password });
    expect(response.statusCode, response.body).toBe(200);
    return { email: address, cookie: cookies(response), userId: response.json().user.id as string };
  }
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Use a dedicated database ending in _test");
    await prisma.rateLimit.deleteMany();
    app = await buildApp({ config, mailer: async (mail) => {
      if (mail.kind === "companion-invite" && mail.to === failedCompanionAddress) throw new Error("Test mail delivery failure");
      mails.push(mail);
    } });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close(); await prisma.$disconnect();
  });
  it("manages private companion requests, enforces acceptance, and deduplicates concurrent requests", async () => {
    const [sender, recipient, outsider] = [await signup(), await signup(), await signup()];
    const path = "/api/companions";
    const call = (method: "GET" | "POST" | "DELETE", url: string, cookie = "", payload?: { email: string }, origin = config.WEB_ORIGIN) =>
      app.inject({ method, url, headers: { cookie, origin }, payload });
    const invite = (cookie: string, address: string) => call("POST", path, cookie, { email: address });
    const get = async (cookie: string) => {
      const response = await call("GET", path, cookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      return response.json();
    };
    const empty = { accepted: [], incoming: [], outgoing: [] };
    expect((await call("GET", path)).statusCode).toBe(401);
    expect((await call("POST", path, sender.cookie, { email: recipient.email }, "https://foreign.example")).statusCode).toBe(403);
    expect((await invite(sender.cookie, sender.email)).json().code).toBe("COMPANION_SELF");
    expect((await invite(sender.cookie, `${randomUUID()}@example.test`)).statusCode).toBe(404);
    expect(await get(sender.cookie)).toEqual(empty);

    const crossed = await Promise.all([invite(sender.cookie, recipient.email.toUpperCase()), invite(recipient.cookie, sender.email)]);
    expect(crossed.map(({ statusCode }) => statusCode).sort()).toEqual([204, 409]);
    const initiator = crossed[0].statusCode === 204 ? sender : recipient;
    const addressee = initiator === sender ? recipient : sender;
    const outgoing = await get(initiator.cookie);
    const incoming = await get(addressee.cookie);
    const id = outgoing.outgoing[0].id;
    const item = { id, name: "Teszt Utazó" };
    expect(outgoing).toEqual({ ...empty, outgoing: [item] });
    expect(incoming).toEqual({ ...empty, incoming: [item] });
    expect((await invite(initiator.cookie, addressee.email)).statusCode).toBe(204);
    expect(mails.filter(({ kind }) => kind === "companion-invite")).toEqual([{
      kind: "companion-invite", to: addressee.email, requesterName: "Teszt Utazó",
      url: `${config.WEB_ORIGIN}/belepes?folytatas=utitarsak`,
    }]);
    expect(await get(outsider.cookie)).toEqual(empty);
    const detail = `${path}/${id}`;
    expect((await call("POST", `${detail}/accept`, initiator.cookie)).statusCode).toBe(404);
    expect((await call("POST", `${detail}/accept`, outsider.cookie)).statusCode).toBe(404);
    expect((await call("DELETE", detail, outsider.cookie)).statusCode).toBe(404);
    expect((await call("POST", `${detail}/accept`, addressee.cookie)).statusCode).toBe(204);
    expect((await call("POST", `${detail}/accept`, addressee.cookie)).statusCode).toBe(204);
    expect(await get(initiator.cookie)).toEqual({ ...empty, accepted: [item] });
    expect(await get(addressee.cookie)).toEqual({ ...empty, accepted: [item] });
    expect((await invite(initiator.cookie, addressee.email)).json().code).toBe("COMPANION_ALREADY_ACCEPTED");
    expect((await call("DELETE", detail, addressee.cookie)).statusCode).toBe(204);
    expect(await get(initiator.cookie)).toEqual(empty);
    expect(await get(addressee.cookie)).toEqual(empty);

    failedCompanionAddress = addressee.email;
    try {
      expect((await invite(initiator.cookie, addressee.email)).statusCode).toBe(204);
      expect((await get(addressee.cookie)).incoming).toHaveLength(1);
      expect(mails.filter(({ kind }) => kind === "companion-invite")).toHaveLength(1);
    } finally {
      failedCompanionAddress = undefined;
    }

    for (let index = 0; index < 10; index++) {
      expect((await invite(outsider.cookie, outsider.email)).statusCode).toBe(400);
    }
    const limited = await invite(outsider.cookie, outsider.email);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it("V28/V29: creates isolated trips, scopes slugs to owners, and keeps the slug on rename", async () => {
    const owner = await signup();
    const other = await signup();
    const url = "/api/trips";
    const get = (path: string, cookie: string) => app.inject({ url: path, headers: { cookie } });
    const write = (method: "POST" | "PUT", path: string, cookie: string, payload: unknown, origin = config.WEB_ORIGIN) =>
      app.inject({ method, url: path, headers: { cookie, origin, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    const date = "2026-11-18";
    const destination = { id: "destination", label: "Pécs", coordinates: [18.23, 46.07] };
    const input = { id: randomUUID(), destination, start: date, end: date };
    const first = { id: "museum", label: "Múzeum", coordinates: [18.24, 46.08] };
    const second = { id: "park", label: "Park", coordinates: [18.25, 46.09] };
    const plan = { destination, start: date, end: date, days: [{ date, stops: [first, second] }] };

    expect((await get(url, "")).statusCode).toBe(401);
    expect((await write("POST", url, owner.cookie, input, "https://example.test")).statusCode).toBe(403);
    expect((await write("POST", url, owner.cookie, { ...input, end: "2026-11-17" })).statusCode).toBe(400);
    const created = await write("POST", url, owner.cookie, input);
    expect(created.statusCode, created.body).toBe(201);
    const slug = "pecs-2026-11";
    expect(created.json()).toEqual({ slug, name: "Pécs", version: 1, plan: { ...plan, days: [] } });
    expect((await write("POST", url, owner.cookie, input)).json()).toEqual(created.json());
    const another = await write("POST", url, owner.cookie, { ...input, id: randomUUID() });
    expect(another.json()).toMatchObject({ slug: "pecs-2026-11-2", version: 1 });
    expect((await get(url, owner.cookie)).json()).toHaveLength(2);
    expect((await get(url, other.cookie)).json()).toEqual([]);

    const detail = `${url}/${slug}`;
    expect((await get(`${detail}/cover`, "")).statusCode).toBe(401);
    expect((await get(`${detail}/cover`, other.cookie)).statusCode).toBe(404);
    const edited = { name: "Pécsi hétvége", version: 1, plan };
    expect((await get(detail, other.cookie)).statusCode).toBe(404);
    expect((await write("PUT", detail, other.cookie, edited)).statusCode).toBe(404);
    expect((await write("POST", url, other.cookie, input)).json()).toMatchObject({ slug });
    const saved = await write("PUT", detail, owner.cookie, edited);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ slug, name: edited.name, version: 2, plan });
    const loaded = await get(detail, owner.cookie);
    expect(loaded.headers["cache-control"]).toBe("no-store");
    expect(loaded.json()).toEqual(saved.json());
    expect((await get(detail, other.cookie)).json()).toEqual(created.json());
    expect((await write("PUT", detail, owner.cookie, edited)).json()).toEqual(saved.json());
    expect((await write("PUT", detail, owner.cookie, { ...edited, name: "Elavult módosítás" })).statusCode).toBe(409);
    expect((await get(`${url}/pecs-2026-11-2`, owner.cookie)).json()).toEqual(another.json());
  });

  it("V1/V6: registration grants immediate unverified access and preserves profiles", async () => {
    const profileId = randomUUID();
    await prisma.userProfile.create({ data: { id: profileId, email: `${profileId}@example.com` } });
    try {
      const user = await signup();
      const me = await app.inject({ url: "/api/me", headers: { cookie: user.cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ user: { id: user.userId, name: "Teszt Utazó", email: user.email, emailVerified: false } });
      expect(me.headers["cache-control"]).toBe("no-store");
      expect(await prisma.userProfile.findUnique({ where: { id: profileId } })).not.toBeNull();
      expect(mails.find((mail) => mail.to === user.email)?.kind).toBe("verification");
      const duplicate = await request("/sign-up/email", { name: "Másik", email: user.email, password });
      expect(duplicate.statusCode).toBe(422);
    } finally { await prisma.userProfile.delete({ where: { id: profileId } }); }
  });
  it("V2: validates passwords and nonempty names", async () => {
    for (const value of ["short", "x".repeat(7), "x".repeat(129)]) {
      expect((await request("/sign-up/email", { name: "Teszt", email: email(), password: value })).statusCode).toBe(400);
    }
    expect((await request("/sign-up/email", { name: "   ", email: email(), password })).statusCode).toBe(400);
    expect((await request("/sign-up/email", { name: "Teszt", email: email(), password: "x".repeat(8) })).statusCode).toBe(200);
  });
  it("V1/V3: rejects bad credentials, expired sessions, and logged-out sessions", async () => {
    const user = await signup();
    expect((await request("/sign-in/email", { email: user.email, password: "wrong-password" })).statusCode).toBe(401);
    const login = await request("/sign-in/email", { email: user.email, password });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === "Lax")).toBe(true);
    const cookie = cookies(login);
    expect((await request("/sign-out", {}, cookie)).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
    await prisma.session.updateMany({ where: { userId: user.userId }, data: { expiresAt: new Date(0) } });
    expect((await app.inject({ url: "/api/me", headers: { cookie: user.cookie } })).statusCode).toBe(401);
  });
  it("V2: verifies emails and rejects invalid and expired verification tokens", async () => {
    const user = await signup();
    const link = new URL(mails.find((mail) => mail.to === user.email)!.url);
    const result = await request(`/verify-email${link.search}`);
    expect(result.statusCode).toBe(302);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).emailVerified).toBe(true);
    const invalid = await request("/verify-email?token=invalid&callbackURL=/email-megerosites");
    expect(invalid.headers.location).toContain("error=");
    const { createEmailVerificationToken } = await import("better-auth/api");
    const expired = await createEmailVerificationToken(config.BETTER_AUTH_SECRET, user.email, undefined, -1);
    expect((await request(`/verify-email?token=${expired}&callbackURL=/email-megerosites`)).headers.location).toContain("error=");
  });
  it("V2: resend, reset, token reuse, and all-session revocation", async () => {
    const user = await signup();
    const second = await request("/sign-in/email", { email: user.email, password });
    expect((await request("/send-verification-email", { email: user.email, callbackURL: "/email-megerosites" }, user.cookie)).statusCode).toBe(200);
    const reset = await request("/request-password-reset", { email: user.email, redirectTo: `${config.WEB_ORIGIN}/uj-jelszo` });
    const unknown = await request("/request-password-reset", { email: email(), redirectTo: `${config.WEB_ORIGIN}/uj-jelszo` });
    expect(reset.json()).toEqual(unknown.json());
    const link = new URL(mails.find((mail) => mail.to === user.email && mail.kind === "reset")!.url);
    const callback = await app.inject({ url: `${link.pathname}${link.search}` });
    const token = new URL(callback.headers.location!).searchParams.get("token")!;
    const nextPassword = `${password}-new`;
    expect((await request("/reset-password", { token, newPassword: nextPassword })).statusCode).toBe(200);
    expect((await request("/reset-password", { token, newPassword: nextPassword })).statusCode).toBe(400);
    for (const cookie of [user.cookie, cookies(second)]) expect((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await request("/sign-in/email", { email: user.email, password })).statusCode).toBe(401);
    expect((await request("/sign-in/email", { email: user.email, password: nextPassword })).statusCode).toBe(200);
    await request("/request-password-reset", { email: user.email, redirectTo: `${config.WEB_ORIGIN}/uj-jelszo` });
    const last = new URL(mails.filter((mail) => mail.to === user.email && mail.kind === "reset").at(-1)!.url);
    const expiredToken = last.pathname.split("/").at(-1)!;
    const expiredRows = await prisma.verification.updateMany({ where: { identifier: `reset-password:${expiredToken}` }, data: { expiresAt: new Date(0) } });
    expect(expiredRows.count).toBe(1);
    expect((await request("/reset-password", { token: expiredToken, newPassword: password })).statusCode).toBe(400);
  });
  it("V4: rejects untrusted origins and spoofed client IPs; persists rate limits", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", remoteAddress: "192.0.2.200", headers: { origin: "https://evil.example" }, payload: { email: email(), password } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().code).toBe("INVALID_ORIGIN");
    const address = email();
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", remoteAddress: "192.0.2.201", headers: { origin: config.WEB_ORIGIN, "x-csavargo-client-ip": `198.51.100.${i}`, "x-forwarded-for": `198.51.100.${i}` }, payload: { email: address, password } });
      expect(response.statusCode).toBe(401);
    }
    expect((await request("/sign-in/email", { email: address, password }, undefined, "192.0.2.201")).statusCode).toBe(429);
    const key = `global-test-${randomUUID()}`;
    for (let i = 0; i < 100; i++) expect(await consumeAuthLimit(prisma, key)).toBe(true);
    expect(await consumeAuthLimit(prisma, key)).toBe(false);
    await prisma.rateLimit.delete({ where: { key: `auth-global:${key}` } });
  });
  it("V5: mail delivery failure does not roll back registration", async () => {
    const failing = await buildApp({ config, mailer: async () => { throw new Error("SMTP unavailable"); } });
    try {
      const result = await failing.inject({ method: "POST", url: "/api/auth/sign-up/email", remoteAddress: "192.0.2.202", headers: { origin: config.WEB_ORIGIN }, payload: { name: "Teszt", email: email(), password } });
      expect(result.statusCode).toBe(200);
      expect(result.json().token).toBeTruthy();
    } finally { await failing.close(); }
  });
  it("V2/V3: configured durations, cookie policy, and password hashing", async () => {
    const auth = createAuth(prisma, config, async () => {}, app.log);
    expect(auth.options.session).toMatchObject({ expiresIn: 604800, updateAge: 86400, cookieCache: { enabled: false } });
    expect(auth.options.emailVerification?.expiresIn).toBe(86400);
    expect(auth.options.emailAndPassword).toMatchObject({ resetPasswordTokenExpiresIn: 3600, revokeSessionsOnPasswordReset: true });
    const user = await signup();
    expect((await prisma.account.findFirstOrThrow({ where: { userId: user.userId } })).password).not.toBe(password);
    const prod = createAuth(prisma, { ...config, NODE_ENV: "production", BETTER_AUTH_URL: "https://csavargo.example", WEB_ORIGIN: "https://csavargo.example" }, async () => {}, app.log);
    expect(prod.options.advanced?.defaultCookieAttributes).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
  });
});
