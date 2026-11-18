import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = process.env.AUTH_TEST_DATABASE_URL;
describe.skipIf(!url)("additive migration", () => {
  it("V6: baselines existing UserProfile without deleting its data", async () => {
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Dedicated test database required");
    const name = `csavargo_migration_${randomUUID().replaceAll("-", "")}_test`;
    if (!/^csavargo_migration_[a-f0-9]+_test$/.test(name)) throw new Error("Unsafe database name");
    const admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const target = new URL(url); target.pathname = `/${name}`;
    const db = new Client({ connectionString: target.toString() });
    try {
      await db.connect();
      await db.query(await readFile("prisma/migrations/202611100001_baseline/migration.sql", "utf8"));
      await db.query(`INSERT INTO "UserProfile" (id, email) VALUES ($1, $2)`, ["preserved-profile", "preserve@example.com"]);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: target.toString() }, encoding: "utf8", timeout: 30000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect((await db.query(`SELECT email FROM "UserProfile" WHERE id=$1`, ["preserved-profile"])).rows).toEqual([{ email: "preserve@example.com" }]);
      expect((await db.query(`SELECT count(*) FROM "User"`)).rows[0].count).toBe("0");

      // Exercise the upgrade from an account with an existing, versioned itinerary.
      await db.query("CREATE SCHEMA legacy_upgrade");
      await db.query("SET search_path TO legacy_upgrade");
      for (const migration of ["202611100001_baseline", "202611100002_auth", "202611180001_trip_plan"]) {
        await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8"));
      }
      await db.query(`INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, $2, $3, NOW())`,
        ["legacy-user", "Utazó", "legacy@example.com"]);
      const destination = { id: "pecs", label: "Pécs", coordinates: [18.23, 46.07] };
      const date = "2026-11-18";
      const plan = { destination, start: date, end: date, days: [{ date, stops: [
        { id: "park", label: "Park", coordinates: [18.25, 46.09] },
        { id: "museum", label: "Múzeum", coordinates: [18.24, 46.08] },
      ] }] };
      await db.query(`INSERT INTO "TripPlan" ("userId", version, plan) VALUES ($1, $2, $3)`, ["legacy-user", 4, plan]);
      await db.query(await readFile("prisma/migrations/202611180002_multiple_trips/migration.sql", "utf8"));
      expect((await db.query(`SELECT id, slug, name, version, plan FROM "TripPlan"`)).rows)
        .toEqual([{ id: "legacy", slug: "pecs-2026-11", name: "Pécs", version: 4, plan }]);
    } finally {
      await db.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  }, 40000);
});
