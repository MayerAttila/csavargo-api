import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";

// Atomic aggregate bucket in addition to Better Auth's per-endpoint limits.
export async function consumeAuthLimit(prisma: PrismaClient, ip: string) {
  const now = BigInt(Date.now());
  const cutoff = now - 60000n;
  const key = `auth-global:${ip}`;
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" (id, key, count, "lastRequest") VALUES (${randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateLimit"."lastRequest" <= ${cutoff} THEN 1 ELSE "RateLimit".count + 1 END,
      "lastRequest" = CASE WHEN "RateLimit"."lastRequest" <= ${cutoff} THEN ${now} ELSE "RateLimit"."lastRequest" END
    WHERE "RateLimit"."lastRequest" <= ${cutoff} OR "RateLimit".count < 100
    RETURNING count
  `;
  return rows.length > 0;
}
