import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import sharp from "sharp";
import { forwardAuthResponse } from "../src/modules/auth/routes.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/lib/config.js";
import { safeRequestUrl } from "../src/lib/logging.js";
import { normalizeAvatar, storedAvatar } from "../src/modules/auth/avatar.js";
import { createAvatarStore } from "../src/modules/auth/avatar-store.js";

describe("auth HTTP boundary", () => {
  it("normalizes raster profile images and rejects invalid or unsupported uploads", async () => {
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#3b82f6" } }).png().toBuffer();
    const image = await normalizeAvatar("data:image/png;base64," + png.toString("base64"));
    expect(storedAvatar(image)).toBe(image);
    const metadata = await sharp(Buffer.from(image!.split(",")[1], "base64")).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 192, height: 192 });
    await expect(normalizeAvatar("data:image/webp;base64," + png.toString("base64"))).rejects.toMatchObject({ body: { code: "INVALID_AVATAR" } });
    await expect(normalizeAvatar("data:image/svg+xml;base64,PHN2Zz4=")).rejects.toMatchObject({ body: { code: "INVALID_AVATAR" } });
    await expect(normalizeAvatar(null)).resolves.toBeNull();
    expect(storedAvatar("https://example.test/avatar.png")).toBeUndefined();
  });
  it("uses Supabase's private object API and sends the secret only in the apikey header", async () => {
    const storage = readConfig({
      DATABASE_URL: "postgresql://localhost/test", BETTER_AUTH_SECRET: "a".repeat(32),
      SUPABASE_URL: "https://example.supabase.co/", SUPABASE_SECRET_KEY: "sb_secret_test",
    }).storage!;
    const image = Buffer.from("webp");
    const fetchObject = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(image)))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const store = createAvatarStore(storage, fetchObject);
    const key = "avatars/example.webp";
    await store.put(key, image);
    expect(await store.get(key)).toEqual(image);
    await store.remove(key);
    expect(fetchObject.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://example.supabase.co/storage/v1/object/avatars/avatars/example.webp", "POST"],
      ["https://example.supabase.co/storage/v1/object/authenticated/avatars/avatars/example.webp", "GET"],
      ["https://example.supabase.co/storage/v1/object/avatars", "DELETE"],
    ]);
    for (const [, init] of fetchObject.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe("sb_secret_test");
      expect(headers.has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
    }
    expect(fetchObject.mock.calls[0][1]?.body).toEqual(Uint8Array.from(image));
    expect(JSON.parse(String(fetchObject.mock.calls[2][1]?.body))).toEqual({ prefixes: [key] });
  });
  it("V38: maps Supabase's legacy NoSuchKey envelope to a missing object", async () => {
    const store = createAvatarStore({
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_AVATAR_BUCKET: "avatars", SUPABASE_SECRET_KEY: "sb_secret_test",
    }, vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ statusCode: "404", code: "NoSuchKey", error: "not_found" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ statusCode: "403", code: "AccessDenied" }, { status: 400 })));
    await expect(store.get("avatars/example.webp")).resolves.toBeNull();
    await expect(store.get("avatars/example.webp")).rejects.toThrow("Supabase Storage GET failed (400)");
  });
  it("V9: redacts reset path tokens and verification query tokens", () => {
    expect(safeRequestUrl("/api/auth/reset-password/secret-token?callbackURL=x")).toBe("/api/auth/reset-password/[REDACTED]");
    expect(safeRequestUrl("/api/auth/verify-email?token=secret-token")).toBe("/api/auth/verify-email");
  });
  it("V3: preserves each Set-Cookie and redirects without combining cookie headers", async () => {
    const app = Fastify();
    app.get("/test", async (_request, reply) => {
      const headers = new Headers({ location: "/attekintes" });
      headers.append("set-cookie", "one=1; Path=/; HttpOnly");
      headers.append("set-cookie", "two=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/");
      forwardAuthResponse(new Response(null, { status: 302, headers }), reply);
      return reply.send();
    });
    try {
      const response = await app.inject({ url: "/test" });
      expect(response.statusCode).toBe(302);
      expect(response.cookies.map((cookie) => cookie.name)).toEqual(["one", "two"]);
      expect(response.headers.location).toBe("/attekintes");
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });
  it("V8: publishes a Zod-derived authenticated me contract without database initialization", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ url: "/api/me" });
      expect(response.statusCode).toBe(401);
      const unavailable = await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: {} });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json().code).toBe("AUTH_UNAVAILABLE");
      const contract = (await app.inject({ url: "/api/openapi.json" })).json();
      expect(contract.paths["/api/me"].get.responses["200"].content["application/json"].schema.properties.user.required).toContain("emailVerified");
      expect(contract.paths["/api/me/avatar/{version}"].get.responses["200"].content["image/webp"].schema.format).toBe("binary");
    } finally { await app.close(); }
  });
  it("requires HTTPS and Resend configuration in production", () => {
    expect(() => readConfig({ NODE_ENV: "production", DATABASE_URL: "postgresql://localhost/test", BETTER_AUTH_SECRET: "a".repeat(32) })).toThrow("HTTPS");
  });
});
