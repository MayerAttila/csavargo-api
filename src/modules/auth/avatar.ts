import { APIError } from "better-auth/api";
import sharp from "sharp";
import { z } from "zod";

const avatarSize = 192;
const maxDataUrlLength = 300_000;
const maxStoredAvatarLength = 65_536;
const avatarPrefix = "data:image/webp;base64,";
export const avatarContentSchema = z.any().meta({ content: { "image/webp": { schema: { type: "string", format: "binary" } } } });
const signatures = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: Buffer.from("RIFF"),
};

export function storedAvatar(image: string | null | undefined) {
  return image?.startsWith(avatarPrefix) && image.length <= maxStoredAvatarLength ? image : undefined;
}

export function avatarObjectKey(image: string | null | undefined) {
  return /^supabase:(avatars\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp)$/.exec(image ?? "")?.[1];
}

export function avatarSource(image: string | null | undefined) {
  const key = avatarObjectKey(image);
  return key ? `/api/me/avatar/${key.slice("avatars/".length, -".webp".length)}` : storedAvatar(image);
}

export function avatarBytes(dataUrl: string) {
  return Buffer.from(dataUrl.slice(avatarPrefix.length), "base64");
}

export async function normalizeAvatar(image: unknown): Promise<string | null | undefined> {
  if (image === undefined || image === null) return image;
  try {
    if (typeof image !== "string" || image.length > maxDataUrlLength) throw new Error("Invalid avatar size");
    const match = /^data:image\/(jpeg|png|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(image);
    if (!match) throw new Error("Invalid avatar data");
    const formatHint = match[1] as keyof typeof signatures;
    const bytes = Buffer.from(match[2], "base64");
    const signature = signatures[formatHint];
    if (!bytes.subarray(0, signature.length).equals(signature) ||
      (formatHint === "webp" && bytes.toString("ascii", 8, 12) !== "WEBP")) throw new Error("Invalid avatar signature");
    const input = sharp(bytes, { limitInputPixels: 1_048_576 });
    const { format } = await input.metadata();
    if (format !== match[1]) throw new Error("Invalid avatar format");
    const output = await input.rotate().resize(avatarSize, avatarSize, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
    const dataUrl = avatarPrefix + output.toString("base64");
    if (dataUrl.length > maxStoredAvatarLength) throw new Error("Avatar exceeds storage limit");
    return dataUrl;
  } catch {
    throw new APIError("BAD_REQUEST", { code: "INVALID_AVATAR", message: "Érvénytelen profilkép." });
  }
}
