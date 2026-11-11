import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { forwardAuthResponse } from "../src/modules/auth/routes.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/lib/config.js";
import { safeRequestUrl } from "../src/lib/logging.js";

describe("auth HTTP boundary", () => {
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
    } finally { await app.close(); }
  });
  it("requires HTTPS and Resend configuration in production", () => {
    expect(() => readConfig({ NODE_ENV: "production", DATABASE_URL: "postgresql://localhost/test", BETTER_AUTH_SECRET: "a".repeat(32) })).toThrow("HTTPS");
  });
});
