// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting it would make the port hard to diff against the source.
// biome-ignore-all lint/performance/noBarrelFile: one re-export of a shared limit, as in the source; not a barrel.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/suspicious/noBitwiseOperators: ported verbatim; byte and bit arithmetic (binary headers, hashing, colour channels).
/**
 * File-type detection and dimension parsing for uploaded images (docs/cms-plan.md §3.6 Media).
 * The type comes from the bytes only: the file name and the client's Content-Type are ignored,
 * and anything that isn't one of the five raster formats (SVG included) is rejected.
 * Pure: no Cloudflare or DOM APIs, so it runs in Workers and in tests.
 */

export type ImageType = { mime: string; ext: string };

export const IMAGE_TYPES = {
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png: { mime: "image/png", ext: "png" },
  gif: { mime: "image/gif", ext: "gif" },
  webp: { mime: "image/webp", ext: "webp" },
  avif: { mime: "image/avif", ext: "avif" },
} as const satisfies Record<string, ImageType>;

/** Upload limit, enforced by the API route before and after reading the body. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** Largest accepted width or height (shared with the image block's schema). */
export { MAX_MEDIA_EDGE } from "./limits";

const ascii = (b: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...b.subarray(at, at + len));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type the bytes start with, or null for anything else (SVG, text, other formats). */
export function detectImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return IMAGE_TYPES.jpeg;
  }
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) {
    return IMAGE_TYPES.png;
  }
  if (
    b.length >= 6 &&
    (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")
  ) {
    return IMAGE_TYPES.gif;
  }
  if (
    b.length >= 12 &&
    ascii(b, 0, 4) === "RIFF" &&
    ascii(b, 8, 4) === "WEBP"
  ) {
    return IMAGE_TYPES.webp;
  }
  if (isAvif(b)) {
    return IMAGE_TYPES.avif;
  }
  return null;
}

const FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp"
const AVIF_BRANDS = [
  [0x61, 0x76, 0x69, 0x66], // "avif" (still image)
  [0x61, 0x76, 0x69, 0x73], // "avis" (image sequence)
];

/** True when `sig` appears at `at`, comparing bytes (no strings, so no cost proportional to the file). */
const bytesAt = (b: Uint8Array, at: number, sig: readonly number[]) =>
  at + sig.length <= b.length && sig.every((v, i) => b[at + i] === v);

/**
 * ISO-BMFF `ftyp` box whose major or compatible brands include `avif` or `avis`. The box must be
 * the first one, between 16 and 256 bytes, and inside the file; only its own brands are read, so
 * "avif" appearing later in arbitrary bytes doesn't count.
 */
function isAvif(b: Uint8Array): boolean {
  if (b.length < 16 || !bytesAt(b, 4, FTYP)) {
    return false;
  }
  const size = u32be(b, 0);
  if (size < 16 || size > 256 || size > b.length) {
    return false;
  }
  // Major brand at 8, minor version at 12, compatible brands from 16 to the end of the box.
  const isBrand = (at: number) =>
    AVIF_BRANDS.some((brand) => bytesAt(b, at, brand));
  if (isBrand(8)) {
    return true;
  }
  for (let at = 16; at + 4 <= size; at += 4) {
    if (isBrand(at)) {
      return true;
    }
  }
  return false;
}

export type Dimensions = { width: number; height: number };

/** Pixel size from the file header, or null when it can't be read (always null for AVIF). */
export function imageDimensions(
  b: Uint8Array,
  type: ImageType
): Dimensions | null {
  switch (type.mime) {
    case IMAGE_TYPES.png.mime:
      // IHDR is always the first chunk: width and height follow its type at offset 16.
      return b.length >= 24 && ascii(b, 12, 4) === "IHDR"
        ? { width: u32be(b, 16), height: u32be(b, 20) }
        : null;
    case IMAGE_TYPES.gif.mime:
      return b.length >= 10
        ? { width: u16le(b, 6), height: u16le(b, 8) }
        : null;
    case IMAGE_TYPES.webp.mime:
      return webpDimensions(b);
    case IMAGE_TYPES.jpeg.mime:
      return jpegDimensions(b);
    default:
      return null;
  }
}

function webpDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 30) {
    return null;
  }
  switch (ascii(b, 12, 4)) {
    case "VP8 ": // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height.
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
        return null;
      }
      return { width: u16le(b, 26) & 0x3f_ff, height: u16le(b, 28) & 0x3f_ff };
    case "VP8L": {
      // Lossless: signature 0x2f, then 14 bits width-1 and 14 bits height-1, little-endian.
      if (b[20] !== 0x2f) {
        return null;
      }
      const bits =
        (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return {
        width: (bits & 0x3f_ff) + 1,
        height: ((bits >>> 14) & 0x3f_ff) + 1,
      };
    }
    case "VP8X": // Extended: 24-bit canvas width-1 and height-1 after 4 bytes of flags.
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    default:
      return null;
  }
}

/** Walks the marker segments to the first start-of-frame (EXIF and other APPn segments may precede it). */
function jpegDimensions(b: Uint8Array): Dimensions | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      return null;
    }
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1; // Fill byte.
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    // SOF0-15, except DHT (c4), JPG (c8) and DAC (cc).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (at + 9 > b.length) {
        return null;
      }
      return { width: u16be(b, at + 7), height: u16be(b, at + 5) };
    }
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

const APP1 = 0xe1; // EXIF (camera, GPS, orientation) and XMP.
const APP13 = 0xed; // Photoshop IRB / IPTC (can hold location text and an embedded EXIF block).
const SOS = 0xda;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/**
 * Drops the APP1 (EXIF/XMP) and APP13 (IPTC) segments from a JPEG; everything else (APP0 JFIF,
 * APP2 ICC profile, APP14 Adobe colour transform, tables, the scan) is copied unchanged.
 * `orientation` is the EXIF orientation that was removed (1 when there was none): anything other
 * than 1 means the stripped image now displays rotated or flipped. Null for a malformed header.
 */
export function stripJpegMetadata(
  b: Uint8Array
): { bytes: Uint8Array; orientation: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    return null;
  }
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let orientation = 1;
  let at = 2;
  while (at < b.length) {
    if (b[at] !== 0xff || at + 1 >= b.length) {
      return null;
    }
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1; // Fill byte.
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      kept.push(b.subarray(at, at + 2));
      at += 2;
      if (marker === 0xd9) {
        break; // EOI before any scan.
      }
      continue;
    }
    if (at + 4 > b.length) {
      return null;
    }
    const end = at + 2 + u16be(b, at + 2);
    if (end > b.length || end < at + 4) {
      return null;
    }
    if (marker === SOS) {
      kept.push(b.subarray(at)); // Entropy-coded data and the rest of the file, verbatim.
      break;
    }
    if (marker === APP1 && bytesAt(b, at + 4, EXIF_HEADER)) {
      orientation = exifOrientation(b.subarray(at + 10, end)) ?? orientation;
    }
    if (marker !== APP1 && marker !== APP13) {
      kept.push(b.subarray(at, end));
    }
    at = end;
  }
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return { bytes: out, orientation };
}

/** Orientation tag (0x0112) from IFD0 of a TIFF block (the EXIF payload), or null. */
function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 8) {
    return null;
  }
  const le = t[0] === 0x49 && t[1] === 0x49; // "II" little-endian, else "MM".
  if (!(le || (t[0] === 0x4d && t[1] === 0x4d))) {
    return null;
  }
  const u16 = (at: number) => (le ? u16le(t, at) : u16be(t, at));
  const u32 = (at: number) =>
    le ? (u16le(t, at) | (u16le(t, at + 2) << 16)) >>> 0 : u32be(t, at);
  const ifd = u32(4);
  if (ifd + 2 > t.length) {
    return null;
  }
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > t.length) {
      return null;
    }
    if (u16(entry) === 0x01_12) {
      return u16(entry + 8);
    }
  }
  return null;
}

/**
 * True for an animated WebP (VP8X animation flag) or APNG (`acTL` before the first `IDAT`), and
 * for every GIF. Reads only the chunks present in `b`, so the first 64 KB of a file is enough.
 */
export function isAnimated(b: Uint8Array, type: ImageType): boolean {
  switch (type.mime) {
    case IMAGE_TYPES.gif.mime:
      return true;
    case IMAGE_TYPES.webp.mime:
      return (
        b.length > 20 && ascii(b, 12, 4) === "VP8X" && (b[20]! & 0x02) !== 0
      );
    case IMAGE_TYPES.png.mime:
      for (let at = 8; at + 8 <= b.length; at += 12 + u32be(b, at)) {
        const chunk = ascii(b, at + 4, 4);
        if (chunk === "acTL") {
          return true;
        }
        if (chunk === "IDAT") {
          return false;
        }
      }
      return false;
    default:
      return false;
  }
}

/** Lowercase hex SHA-256 of the bytes (WebCrypto, available in Workers, browsers and Node). */
export async function sha256Hex(b: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    b as Uint8Array<ArrayBuffer>
  );
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0")
  ).join("");
}

/** Content-addressed id, `<sha256>.<ext>`; matches `mediaIdSchema` (app/cms/media-schema.ts). */
export function mediaIdFor(sha256: string, type: ImageType): string {
  return `${sha256}.${type.ext}`;
}

/** Same pattern as `mediaIdSchema`, without zod, for the public `/media/<id>` route. */
export const MEDIA_ID_RE = /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

/** R2 object key for a media id. */
export function mediaKey(id: string): string {
  return `media/${id}`;
}

/**
 * The AI agent's `render_preview` screenshots, in the media bucket beside the library (never listed
 * as media). Agent transcripts reference them (`r2:<key>`) and are replayed to the model on every
 * request, so they must never be deleted (see `assertBlobDeletable` in media-service.ts).
 */
export const AGENT_SCREENS_PREFIX = "agent/screens/";

/** Content type for a stored id, from its extension (the extension was set from the detected type). */
export function mimeForId(id: string): string | null {
  const ext = id.slice(id.lastIndexOf(".") + 1);
  return Object.values(IMAGE_TYPES).find((t) => t.ext === ext)?.mime ?? null;
}
