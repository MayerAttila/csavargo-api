import { z } from "zod";

const imageUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ["https://thumb.wikimedia.org", "https://upload.wikimedia.org"].includes(url.origin)
    && url.pathname.startsWith("/wikipedia/commons/");
});
const commonsUrl = z.url().refine((value) => new URL(value).origin === "https://commons.wikimedia.org");
const licenseUrl = z.url().refine((value) => new URL(value).origin === "https://creativecommons.org");

export const destinationCover = z.object({
  imageUrl,
  sourceUrl: commonsUrl,
  author: z.string(),
  license: z.string(),
  licenseUrl: licenseUrl.nullable(),
});

type Cover = z.infer<typeof destinationCover>;
type Destination = { label: string; locality?: string; coordinates: [number, number] };

const wikiPages = z.object({
  query: z.object({
    pages: z.array(z.object({
      pageimage: z.string().optional(),
      pageprops: z.object({ disambiguation: z.string().optional() }).optional(),
      coordinates: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
    })),
  }).optional(),
});
const commonsFiles = z.object({
  query: z.object({
    pages: z.array(z.object({
      imageinfo: z.array(z.object({
        thumburl: z.string().optional(),
        descriptionurl: z.string(),
        mime: z.string(),
        extmetadata: z.record(z.string(), z.object({ value: z.string() }).optional()),
      })).optional(),
    })),
  }).optional(),
});

const day = 86_400_000;
const maxCacheEntries = 500;
const maxPendingLookups = 12;
const wikipedia = ["https://en.wikipedia.org", "https://hu.wikipedia.org"];

function distanceKm([longitude, latitude]: Destination["coordinates"], { lon, lat }: { lon: number; lat: number }) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat - latitude) * radians / 2) ** 2
    + Math.cos(latitude * radians) * Math.cos(lat * radians) * Math.sin((lon - longitude) * radians / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function plainText(html: string | undefined) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return (html ?? "").replace(/<\/(?:li|p)>|<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => entities[name])
    .replace(/\s+/g, " ").trim();
}

export function createDestinationCoverLookup(publicUrl: string) {
  const cached = new Map<string, { cover: Cover | null; until: number }>();
  const pending = new Map<string, Promise<Cover | null>>();
  const userAgent = `Csavargo/0.1 (trip destination covers; ${new URL(publicUrl).origin})`;
  let retryAt = 0;

  async function query(origin: string, params: Record<string, string>, signal: AbortSignal) {
    if (Date.now() < retryAt) throw new Error("Wikimedia asked to retry later");
    const url = new URL("/w/api.php", origin);
    url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", maxlag: "5", ...params }).toString();
    const response = await fetch(url, { headers: { "User-Agent": userAgent }, signal, redirect: "error" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter || response.status === 429 || response.status === 503) {
      const time = retryAfter && /^\d+$/.test(retryAfter)
        ? Date.now() + Number(retryAfter) * 1000
        : Date.parse(retryAfter ?? "");
      retryAt = Math.max(retryAt, Number.isFinite(time) ? time : Date.now() + 60_000);
    }
    if (!response.ok) throw new Error("Wikimedia request failed");
    const data = await response.json();
    if (data?.error?.code === "maxlag" && !retryAfter) retryAt = Math.max(retryAt, Date.now() + 60_000);
    if (data?.error) throw new Error("Wikimedia query failed");
    return data;
  }

  async function find(city: string, coordinates: Destination["coordinates"]) {
    const signal = AbortSignal.timeout(5_000);
    for (const origin of wikipedia) {
      const { query: result } = wikiPages.parse(await query(origin, {
        titles: city, redirects: "1", prop: "coordinates|pageprops|pageimages",
        coprimary: "primary", ppprop: "disambiguation", piprop: "name", pilicense: "free",
      }, signal));
      const page = result?.pages[0];
      const location = page?.coordinates?.[0];
      if (!page?.pageimage || page.pageprops?.disambiguation !== undefined || !location || distanceKm(coordinates, location) > 25) continue;

      const { query: files } = commonsFiles.parse(await query("https://commons.wikimedia.org", {
        titles: `File:${page.pageimage}`, redirects: "1", prop: "imageinfo", iiurlwidth: "640",
        iiprop: "url|mime|extmetadata",
        iiextmetadatafilter: "Artist|Attribution|LicenseShortName|LicenseUrl|Restrictions",
      }, signal));
      const info = files?.pages[0]?.imageinfo?.[0];
      if (!info || !["image/jpeg", "image/png", "image/webp"].includes(info.mime)) continue;
      const metadata = info.extmetadata;
      const license = plainText(metadata.LicenseShortName?.value);
      const author = plainText(metadata.Attribution?.value) || plainText(metadata.Artist?.value);
      const url = metadata.LicenseUrl?.value?.replace(/^\/\//, "https://").replace(/^http:/, "https:");
      const isPublicDomain = license === "Public domain" || license === "CC0";
      if (metadata.Restrictions?.value?.trim()
        || (!isPublicDomain && (!/^CC BY(?:-SA)? \d\.\d$/.test(license) || !author || !url))) continue;
      const parsed = destinationCover.safeParse({
        imageUrl: info.thumburl, sourceUrl: info.descriptionurl, author, license, licenseUrl: url ?? null,
      });
      if (parsed.success) return parsed.data;
    }
    return null;
  }

  return async function lookup(destination: Destination): Promise<Cover | null> {
    const city = (destination.locality || destination.label.split(",")[0]).trim();
    if (!city || /[|[\]{}#<>]/.test(city)) return null;
    const key = JSON.stringify([city.normalize("NFC").toLowerCase(), ...destination.coordinates.map((value) => value.toFixed(1))]);
    const hit = cached.get(key);
    if (hit && hit.until > Date.now()) return hit.cover;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (Date.now() < retryAt || pending.size >= maxPendingLookups) return null;

    const lookupResult = find(city, destination.coordinates)
      .then((cover) => ({ cover, lifetime: cover ? 7 * day : day }))
      .catch(() => ({ cover: null, lifetime: 60_000 }))
      .then(({ cover, lifetime }) => {
        cached.delete(key);
        if (cached.size >= maxCacheEntries) {
          const oldest = cached.keys().next();
          if (!oldest.done) cached.delete(oldest.value);
        }
        cached.set(key, { cover, until: Date.now() + lifetime });
        return cover;
      }).finally(() => pending.delete(key));
    pending.set(key, lookupResult);
    return lookupResult;
  };
}
