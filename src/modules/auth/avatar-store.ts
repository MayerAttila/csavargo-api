import type { Config } from "../../lib/config.js";

export type AvatarStore = {
  put: (key: string, data: Buffer) => Promise<void>;
  get: (key: string) => Promise<Buffer | null>;
  remove: (key: string) => Promise<void>;
};

export class AvatarStorageResponseError extends Error {
  constructor(method: string, readonly status: number) {
    super(`Supabase Storage ${method} failed (${status})`);
  }
}

export function createAvatarStore(config: NonNullable<Config["storage"]>, fetchObject: typeof fetch = fetch): AvatarStore {
  const base = `${config.SUPABASE_URL}/storage/v1/object`;
  const bucket = config.SUPABASE_AVATAR_BUCKET;
  const apiKey = config.SUPABASE_SECRET_KEY ?? config.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey) throw new Error("A Supabase server key is required");
  const key: string = apiKey;

  async function request(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("apikey", key);
    if (!config.SUPABASE_SECRET_KEY) headers.set("authorization", `Bearer ${key}`);
    const response = await fetchObject(`${base}/${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (init.method === "GET" && response.status === 400) {
      const error = await response.json().catch(() => null);
      if (error?.code === "NoSuchKey" && String(error.statusCode) === "404") return new Response(null, { status: 404 });
    }
    if (!response.ok && !(init.method === "GET" && response.status === 404)) {
      if (!response.bodyUsed) await response.body?.cancel();
      throw new AvatarStorageResponseError(init.method ?? "GET", response.status);
    }
    return response;
  }

  return {
    async put(key, data) {
      const response = await request(`${bucket}/${key}`, {
        method: "POST",
        headers: { "content-type": "image/webp", "x-upsert": "false" },
        body: Uint8Array.from(data),
      });
      await response.body?.cancel();
    },
    async get(key) {
      const response = await request(`authenticated/${bucket}/${key}`, { method: "GET" });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async remove(key) {
      const response = await request(bucket, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes: [key] }),
      });
      await response.body?.cancel();
    },
  };
}
