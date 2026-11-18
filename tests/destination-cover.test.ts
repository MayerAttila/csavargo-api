import { afterEach, describe, expect, it, vi } from "vitest";
import { createDestinationCoverLookup } from "../src/modules/trips/destination-cover.js";

const paris = { label: "Párizs", coordinates: [2.3522, 48.8566] as [number, number] };
const cityPage = { query: { pages: [{ pageimage: "Paris.jpg", coordinates: [{ lon: 2.35, lat: 48.86 }] }] } };
const photo = {
  thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a0/Paris.jpg/960px-Paris.jpg",
  descriptionurl: "https://commons.wikimedia.org/wiki/File:Paris.jpg",
  mime: "image/jpeg",
  extmetadata: {
    Artist: { value: '<a href="/wiki/User:Jane">Jane &amp; Co</a>' },
    LicenseShortName: { value: "CC BY-SA 4.0" },
    LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
  },
};
const files = (info: typeof photo) => Response.json({ query: { pages: [{ imageinfo: [info] }] } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("trip destination covers", () => {
  it("V30: verifies the location, reads Commons credits and coalesces matching trips", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(cityPage)).mockResolvedValueOnce(files(photo));
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDestinationCoverLookup("https://csavargo.example");
    const [first, second] = await Promise.all([lookup(paris), lookup({ ...paris, label: "Párizs, Franciaország" })]);
    expect(first).toEqual({
      imageUrl: photo.thumburl, sourceUrl: photo.descriptionurl, author: "Jane & Co",
      license: "CC BY-SA 4.0", licenseUrl: photo.extmetadata.LicenseUrl.value,
    });
    expect(second).toEqual(first);
    expect(await lookup(paris)).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][0] as URL).searchParams.get("titles")).toBe("Párizs");
    expect((fetchMock.mock.calls[1][0] as URL).hostname).toBe("commons.wikimedia.org");
  });

  it.each([
    ["https://upload.wikimedia.org", true],
    ["https://example.com", false],
  ])("V30: checks the thumbnail origin %s", async (origin, allowed) => {
    const thumburl = new URL(photo.thumburl);
    const image = `${origin}${thumburl.pathname}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(cityPage))
      .mockResolvedValueOnce(files({ ...photo, thumburl: image }))
      .mockResolvedValueOnce(Response.json({ query: { pages: [{}] } }));
    vi.stubGlobal("fetch", fetchMock);
    const cover = await createDestinationCoverLookup("https://csavargo.example")(paris);
    expect(cover?.imageUrl ?? null).toBe(allowed ? image : null);
  });

  it("skips a same-named city in another country and caches the miss", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(cityPage)));
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDestinationCoverLookup("https://csavargo.example");
    const texasParis = { ...paris, coordinates: [-95.55, 33.66] as [number, number] };
    expect(await lookup(texasParis)).toBeNull();
    expect(await lookup(texasParis)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).hostname)).toEqual(["en.wikipedia.org", "hu.wikipedia.org"]);
  });

  it("uses a fallback for images without the required credit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(cityPage))
      .mockResolvedValueOnce(files({ ...photo, extmetadata: { ...photo.extmetadata, Artist: { value: "" } } }))
      .mockResolvedValueOnce(Response.json({ query: { pages: [{}] } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createDestinationCoverLookup("https://csavargo.example")(paris)).toBeNull();
  });

  it("backs off after a rate limit and retries a transient failure later", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "120" } }))
      .mockResolvedValueOnce(Response.json(cityPage)).mockResolvedValueOnce(files(photo));
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDestinationCoverLookup("https://csavargo.example");
    expect(await lookup(paris)).toBeNull();
    vi.advanceTimersByTime(61_000);
    expect(await lookup(paris)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(await lookup(paris)).toMatchObject({ imageUrl: photo.thumburl });
  });
});
