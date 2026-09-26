import { AppError } from "@/server/lib/errors";
import { stableHash } from "@/shared/intelligence";

// Agency/client logo validation (final-plan §12: MIME/size/dimensions).
// Only PNG and JPEG are accepted because both expose dimensions in plain
// bytes parseable without an image library (Workers-safe). SVG/WebP are
// rejected with a clear error rather than half-validated.

export const BRAND_LOGO_MAX_BYTES = 512 * 1024;
export const BRAND_LOGO_MAX_DIMENSION = 1024;

const ALLOWED_LOGO_MIME = ["image/png", "image/jpeg"] as const;
export type LogoMime = (typeof ALLOWED_LOGO_MIME)[number];

function isAllowedMime(mime: string): mime is LogoMime {
  return (ALLOWED_LOGO_MIME as readonly string[]).includes(mime);
}

export function parseLogoDataUrl(input: string): {
  mime: LogoMime;
  bytes: Uint8Array;
} {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
    input.trim(),
  );
  if (!match?.[1] || !match[2]) {
    throw new AppError("VALIDATION_ERROR", "Logo must be a base64 data URL");
  }
  if (!isAllowedMime(match[1])) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Logo must be a PNG or JPEG image",
    );
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(match[2]);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Logo data is not valid base64");
  }
  if (bytes.length === 0 || bytes.length > BRAND_LOGO_MAX_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Logo must be under 512 KB");
  }
  return { mime: match[1], bytes };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 2 ** 24 +
      bytes[offset + 1]! * 2 ** 16 +
      bytes[offset + 2]! * 2 ** 8 +
      bytes[offset + 3]!) >>>
    0
  );
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 24 ||
    !signature.every((value, index) => bytes[index] === value)
  ) {
    throw new AppError("VALIDATION_ERROR", "Logo is not a valid PNG file");
  }
  // IHDR immediately follows the signature: length(13) + "IHDR" + w/h.
  if (
    readU32BE(bytes, 8) !== 13 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    throw new AppError("VALIDATION_ERROR", "Logo is not a valid PNG file");
  }
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpegDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new AppError("VALIDATION_ERROR", "Logo is not a valid JPEG file");
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new AppError("VALIDATION_ERROR", "Logo is not a valid JPEG file");
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9) break; // EOI
    if (marker === 0xda) break; // SOS: compressed data follows, no SOF found
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // Standalone markers carry no length.
      continue;
    }
    const length = bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) {
      throw new AppError("VALIDATION_ERROR", "Logo is not a valid JPEG file");
    }
    if (isStartOfFrame(marker)) {
      if (length < 7) {
        throw new AppError("VALIDATION_ERROR", "Logo is not a valid JPEG file");
      }
      return {
        width: bytes[offset + 7]! * 256 + bytes[offset + 8]!,
        height: bytes[offset + 5]! * 256 + bytes[offset + 6]!,
      };
    }
    offset += 2 + length;
  }
  throw new AppError("VALIDATION_ERROR", "Logo JPEG has no dimensions header");
}

/** Native dimension parse; throws VALIDATION_ERROR on any mismatch. */
export function logoDimensions(input: {
  mime: LogoMime;
  bytes: Uint8Array;
}): { width: number; height: number } {
  const dimensions =
    input.mime === "image/png"
      ? pngDimensions(input.bytes)
      : jpegDimensions(input.bytes);
  if (
    dimensions.width === 0 ||
    dimensions.height === 0 ||
    dimensions.width > BRAND_LOGO_MAX_DIMENSION ||
    dimensions.height > BRAND_LOGO_MAX_DIMENSION
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Logo dimensions must be 1–1024 px per side",
    );
  }
  return dimensions;
}

export function logoExtension(mime: LogoMime): string {
  return mime === "image/png" ? "png" : "jpg";
}

/** Content-addressed key: identical bytes reuse one object. */
export async function brandLogoKey(
  scope: string,
  bytes: Uint8Array,
  mime: LogoMime,
): Promise<string> {
  const hex = await stableHash(
    Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
  return `branding/${scope}/${hex}.${logoExtension(mime)}`;
}
