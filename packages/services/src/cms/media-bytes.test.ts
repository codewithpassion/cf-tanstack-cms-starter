// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered requests or test steps), as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/useTemplate: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noBitwiseOperators: ported verbatim; byte and bit arithmetic (binary headers, hashing, colour channels).
import { describe, expect, it } from "bun:test";

import { mediaIdSchema } from "@repo/cms-core/media-schema";
import {
  bytes,
  exifApp1,
  FIXTURES,
  withSegment,
} from "../testing/media-fixtures";
import {
  detectImageType,
  IMAGE_TYPES,
  imageDimensions,
  isAnimated,
  MEDIA_ID_RE,
  mediaIdFor,
  mimeForId,
  sha256Hex,
  stripJpegMetadata,
} from "./media-bytes";

const text = (s: string) => new TextEncoder().encode(s);

describe("detectImageType", () => {
  it.each([
    ["jpeg", IMAGE_TYPES.jpeg],
    ["jpegProgressiveExif", IMAGE_TYPES.jpeg],
    ["png", IMAGE_TYPES.png],
    ["gif", IMAGE_TYPES.gif],
    ["webpLossy", IMAGE_TYPES.webp],
    ["webpLossless", IMAGE_TYPES.webp],
    ["webpAlpha", IMAGE_TYPES.webp],
    ["avif", IMAGE_TYPES.avif],
  ] as const)("detects %s", (name, type) => {
    expect(detectImageType(bytes(name))).toEqual(type);
  });

  it("detects GIF89a as well as GIF87a", () => {
    const b = bytes("gif");
    b.set(text("GIF89a"));
    expect(detectImageType(b)).toEqual(IMAGE_TYPES.gif);
  });

  it.each([
    [
      "svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    ],
    [
      "svg with xml prolog",
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    ["svg with BOM and whitespace", "﻿  <svg/>"],
    ["html", "<!doctype html><html></html>"],
    ["plain text", "hello.png"],
    ["empty", ""],
  ])("rejects %s", (_name, src) => {
    expect(detectImageType(text(src))).toBeNull();
  });

  it("rejects other binary formats", () => {
    expect(detectImageType(text("%PDF-1.7\n"))).toBeNull();
    expect(
      detectImageType(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0]))
    ).toBeNull(); // BMP
    // ISO-BMFF that isn't AVIF (an MP4 with brand isom).
    const mp4 = new Uint8Array(24);
    mp4.set([0, 0, 0, 24]);
    mp4.set(text("ftypisom"), 4);
    mp4.set(text("isomiso2"), 16);
    expect(detectImageType(mp4)).toBeNull();
    // RIFF that isn't WebP (WAV).
    expect(detectImageType(text("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
  });

  it("detects AVIF from a compatible brand when the major brand is something else", () => {
    const b = new Uint8Array(24);
    b.set([0, 0, 0, 24]);
    b.set(text("ftypmif1"), 4);
    b.set(text("miafavif"), 16);
    expect(detectImageType(b)).toEqual(IMAGE_TYPES.avif);
  });

  it("ignores the file name: PNG bytes uploaded as photo.jpg are a PNG", async () => {
    const file = new File([bytes("png")], "photo.jpg", { type: "image/jpeg" });
    const type = detectImageType(new Uint8Array(await file.arrayBuffer()));
    expect(type).toEqual(IMAGE_TYPES.png);
  });

  it("ignores the file name: SVG uploaded as logo.png is rejected", async () => {
    const file = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg"/>'],
      "logo.png",
      { type: "image/png" }
    );
    expect(
      detectImageType(new Uint8Array(await file.arrayBuffer()))
    ).toBeNull();
  });
});

describe("AVIF detection bounds", () => {
  /** An `ftyp` header with the given declared box size, then `rest`. */
  const ftyp = (size: number, rest: Uint8Array) => {
    const b = new Uint8Array(16 + rest.length);
    new DataView(b.buffer).setUint32(0, size);
    b.set(text("ftypisom\0\0\0\0"), 4);
    b.set(rest, 16);
    return b;
  };

  it("rejects fake.avif: HTML and junk with 'avif' at the end, under a box size that claims the whole file", () => {
    const body = text(
      `<html><script>alert(1)</script></html>${"x".repeat(1002)}avif`
    );
    expect((16 + body.length - 4) % 4).toBe(0); // "avif" sits where the old brand scan looked.
    expect(detectImageType(ftyp(0xff_ff_ff_ff, body))).toBeNull();
    expect(detectImageType(ftyp(16 + body.length, body))).toBeNull(); // Exact size, but over 256.
  });

  it.each([
    ["0 (box runs to end of file)", 0],
    ["1 (64-bit largesize)", 1],
    ["under 16", 12],
    ["larger than the file", 40],
  ])("rejects a box size of %s", (_name, size) => {
    expect(detectImageType(ftyp(size, text("avifavif")))).toBeNull();
  });

  it("only reads brands inside the declared box", () => {
    // Box is 16 bytes (no compatible brands); "avif" follows outside it.
    expect(detectImageType(ftyp(16, text("avifavif")))).toBeNull();
    expect(detectImageType(ftyp(24, text("mif1avif")))).toEqual(
      IMAGE_TYPES.avif
    );
  });

  it("rejects a huge buffer with a huge box size quickly", () => {
    const big = ftyp(0xff_ff_ff_ff, new Uint8Array(10 * 1024 * 1024));
    const start = performance.now();
    expect(detectImageType(big)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("stripJpegMetadata", () => {
  const hasExif = (b: Uint8Array) => Buffer.from(b).includes("Exif\0\0");

  it("leaves a JPEG without metadata byte-for-byte unchanged", () => {
    const b = bytes("jpeg");
    expect(stripJpegMetadata(b)).toEqual({ bytes: b, orientation: 1 });
  });

  it("drops an EXIF segment with GPS, restoring the original bytes", () => {
    const plain = bytes("jpeg");
    const withGps = withSegment(plain, exifApp1(1));
    expect(hasExif(withGps)).toBe(true);
    const out = stripJpegMetadata(withGps)!;
    expect(out.orientation).toBe(1);
    expect(hasExif(out.bytes)).toBe(false);
    expect(out.bytes).toEqual(plain);
  });

  it("reports the EXIF orientation it removed (little- and big-endian)", () => {
    expect(
      stripJpegMetadata(withSegment(bytes("jpeg"), exifApp1(6)))!.orientation
    ).toBe(6);
    const real = stripJpegMetadata(bytes("jpegProgressiveExif"))!; // Pillow wrote "II", orientation 6.
    expect(real.orientation).toBe(6);
    expect(hasExif(real.bytes)).toBe(false);
    expect(imageDimensions(real.bytes, IMAGE_TYPES.jpeg)).toEqual({
      width: 17,
      height: 260,
    });
  });

  it("drops XMP (APP1) and IPTC (APP13) but keeps APP2 (ICC) and APP14 (Adobe)", () => {
    const seg = (marker: number, payload: string) => {
      const p = text(payload);
      return new Uint8Array([0xff, marker, 0, p.length + 2, ...p]);
    };
    const icc = seg(0xe2, "ICC_PROFILE\0fake");
    const adobe = seg(0xee, "Adobe\0\0\0\0\0\0");
    let b: Uint8Array = bytes("jpeg");
    for (const s of [
      adobe,
      icc,
      seg(0xed, "Photoshop 3.0\0x"),
      seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x/>"),
    ]) {
      b = withSegment(b, s);
    }
    const out = stripJpegMetadata(b)!.bytes;
    const str = Buffer.from(out);
    expect(str.includes("ICC_PROFILE")).toBe(true);
    expect(str.includes("Adobe\0")).toBe(true);
    expect(str.includes("Photoshop")).toBe(false);
    expect(str.includes("ns.adobe.com")).toBe(false);
    expect(out.length).toBe(bytes("jpeg").length + icc.length + adobe.length);
  });

  it("returns null for a malformed header", () => {
    expect(stripJpegMetadata(bytes("jpeg").subarray(0, 30))).toBeNull(); // Segment runs past the end.
    expect(
      stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0x00, 0x00]))
    ).toBeNull();
    expect(stripJpegMetadata(bytes("png"))).toBeNull();
  });
});

describe("isAnimated", () => {
  it("is false for still WebP and PNG, true for GIF", () => {
    expect(isAnimated(bytes("webpAlpha"), IMAGE_TYPES.webp)).toBe(false);
    expect(isAnimated(bytes("webpLossy"), IMAGE_TYPES.webp)).toBe(false);
    expect(isAnimated(bytes("png"), IMAGE_TYPES.png)).toBe(false);
    expect(isAnimated(bytes("gif"), IMAGE_TYPES.gif)).toBe(true);
  });

  it("detects the VP8X animation flag", () => {
    const b = bytes("webpAlpha");
    b[20]! |= 0x02;
    expect(isAnimated(b, IMAGE_TYPES.webp)).toBe(true);
  });

  it("detects an APNG acTL chunk before IDAT", () => {
    const png = bytes("png");
    // acTL: length 8, type, num_frames 2, num_plays 0, CRC (unchecked). Inserted after IHDR (8 + 25).
    const actl = new Uint8Array([
      0,
      0,
      0,
      8,
      ...text("acTL"),
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const apng = new Uint8Array([
      ...png.subarray(0, 33),
      ...actl,
      ...png.subarray(33),
    ]);
    expect(isAnimated(apng, IMAGE_TYPES.png)).toBe(true);
  });
});

describe("imageDimensions", () => {
  it.each([
    "jpeg",
    "jpegProgressiveExif",
    "png",
    "gif",
    "webpLossy",
    "webpLossless",
    "webpAlpha",
  ] as const)("reads %s", (name) => {
    const b = bytes(name);
    const { w, h } = FIXTURES[name];
    expect(imageDimensions(b, detectImageType(b)!)).toEqual({
      width: w,
      height: h,
    });
  });

  it("returns null for AVIF", () => {
    const b = bytes("avif");
    expect(imageDimensions(b, IMAGE_TYPES.avif)).toBeNull();
  });

  it.each([
    "jpeg",
    "png",
    "gif",
    "webpLossy",
    "webpLossless",
    "webpAlpha",
  ] as const)("returns null for a truncated %s instead of throwing", (name) => {
    const b = bytes(name).subarray(0, 9); // Shorter than every header (GIF's is 10 bytes).
    expect(imageDimensions(b, detectImageType(bytes(name))!)).toBeNull();
  });

  it("returns null for a JPEG with no frame header", () => {
    // SOI, then an APP0 segment and EOI: no SOF.
    const b = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
    ]);
    expect(imageDimensions(b, IMAGE_TYPES.jpeg)).toBeNull();
  });
});

describe("media ids", () => {
  it("hashes with SHA-256", async () => {
    expect(await sha256Hex(text("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("builds <sha256>.<ext> ids that pass mediaIdSchema and the route regex", async () => {
    for (const name of ["jpeg", "png", "gif", "webpLossy", "avif"] as const) {
      const b = bytes(name);
      const type = detectImageType(b)!;
      const id = mediaIdFor(await sha256Hex(b), type);
      expect(id).toMatch(new RegExp(`^[a-f0-9]{64}\\.${type.ext}$`));
      expect(mediaIdSchema.safeParse(id).success).toBe(true);
      expect(MEDIA_ID_RE.test(id)).toBe(true);
      expect(mimeForId(id)).toBe(type.mime);
    }
  });

  it("uses the same id for the same bytes, whatever the file was called", async () => {
    const b = bytes("png");
    const a = mediaIdFor(await sha256Hex(b), detectImageType(b)!);
    const c = mediaIdFor(
      await sha256Hex(new Uint8Array(b)),
      detectImageType(new Uint8Array(b))!
    );
    expect(a).toBe(c);
  });

  it.each([
    "../etc/passwd",
    "ABC.png",
    "a".repeat(64) + ".svg+xml",
    "a".repeat(63) + ".png",
    "a".repeat(64),
  ])("the route regex rejects %j", (id) => {
    expect(MEDIA_ID_RE.test(id)).toBe(false);
  });
});
