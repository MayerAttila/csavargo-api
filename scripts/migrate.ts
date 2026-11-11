import "dotenv/config";
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for migrations");
const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
const run = (args: string[]) => {
  const result = spawnSync(process.execPath, [prismaCli, ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Prisma migration command failed");
};
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const { rows: [state] } = await db.query<{ profile: string | null; history: string | null }>(
    `SELECT to_regclass('public."UserProfile"')::text AS profile, to_regclass('public._prisma_migrations')::text AS history`,
  );
  if (state.profile && !state.history) {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='UserProfile' ORDER BY column_name`,
    );
    if (JSON.stringify(rows) !== JSON.stringify([
      { column_name: "createdAt", data_type: "timestamp without time zone" },
      { column_name: "email", data_type: "text" },
      { column_name: "id", data_type: "text" },
    ])) throw new Error("Existing UserProfile differs from baseline; review schema before migrating");
    run(["migrate", "resolve", "--applied", "202611100001_baseline"]);
  }
} finally { await db.end(); }
run(["migrate", "deploy"]);
