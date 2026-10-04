// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered requests or test steps), as in the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning interfaces and callbacks; kept as in the source.
import { describe, expect, it } from "bun:test";
import {
  exifApp1,
  bytes as fixture,
  withSegment,
} from "../testing/media-fixtures";
import { createMemoryMediaRepo } from "../testing/media-memory-repo";
import { IMAGE_TYPES, MAX_MEDIA_BYTES, sha256Hex } from "./media-bytes";
import type { BlobPort } from "./media-repo";
import {
  getMedia,
  IMMUTABLE_CACHE,
  listMedia,
  MEDIA_PAGE_SIZE,
  MediaError,
  type MediaRow,
  updateMediaAlt,
  uploadMedia,
} from "./media-service";

// A valid 1×1 PNG header is enough: the service only reads the signature and IHDR.
function png(width: number, height: number, salt = 0): Uint8Array {
  const b = new Uint8Array(33);
  b.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
    0x44, 0x52,
  ]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[32] = salt; // Different bytes, different id.
  return b;
}

function setup(start = 1_700_000_000_000) {
  const { repo, rows } = createMemoryMediaRepo();
  const puts: {
    key: string;
    size: number;
    contentType: string;
    cacheControl: string;
  }[] = [];
  const stored = new Map<string, Uint8Array>();
  const blobs: BlobPort = {
    async put(key, value, opts) {
      puts.push({ key, size: value.byteLength, ...opts.httpMetadata });
      stored.set(key, value);
      return null;
    },
  };
  let t = start;
  return { deps: { repo, blobs, now: () => t++ }, rows, puts, stored };
}

function row(
  id: string,
  createdAt: number,
  extra: Partial<MediaRow> = {}
): MediaRow {
  return {
    id,
    r2Key: `media/${id}`,
    sha256: id.split(".")[0]!,
    mime: "image/png",
    width: 1,
    height: 1,
    alt: null,
    tags: null,
    source: "upload",
    createdAt: new Date(createdAt),
    ...extra,
  };
}

const hex = (n: number) => n.toString(16).padStart(64, "0");

describe("uploadMedia", () => {
  it("stores a new image in R2 and D1 under its content id", async () => {
    const { deps, rows, puts } = setup();
    const bytes = png(640, 480);
    const { media, created } = await uploadMedia(deps, {
      bytes,
      alt: "  A lake at dusk ",
    });

    const id = `${await sha256Hex(bytes)}.png`;
    expect(created).toBe(true);
    expect(media).toMatchObject({
      id,
      url: `/media/${id}`,
      width: 640,
      height: 480,
      mime: "image/png",
      alt: "A lake at dusk",
      tags: [],
    });
    expect(puts).toEqual([
      {
        key: `media/${id}`,
        size: bytes.byteLength,
        contentType: "image/png",
        cacheControl: IMMUTABLE_CACHE,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      r2Key: `media/${id}`,
      source: "upload",
      sha256: id.slice(0, 64),
    });
  });

  it("records the source, e.g. a share-image screenshot (a plain JFIF with no EXIF)", async () => {
    const { deps, rows } = setup();
    const { media } = await uploadMedia(deps, {
      bytes: fixture("jpeg"),
      alt: "Share image",
      source: "share-image",
    });
    expect(media).toMatchObject({
      mime: "image/jpeg",
      width: 301,
      height: 7,
      alt: "Share image",
    });
    expect(rows[0]!.source).toBe("share-image");
  });

  it("dedupes: the same bytes again return the stored row without writing", async () => {
    const { deps, rows, puts } = setup();
    const first = await uploadMedia(deps, { bytes: png(10, 10), alt: "first" });
    const again = await uploadMedia(deps, {
      bytes: png(10, 10),
      alt: "second",
    });

    expect(again.created).toBe(false);
    expect(again.media).toEqual(first.media);
    expect(again.media.alt).toBe("first");
    expect(puts).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("keeps the first row when a concurrent upload inserted it", async () => {
    const { deps, rows } = setup();
    const bytes = png(3, 3);
    const [a, b] = await Promise.all([
      uploadMedia(deps, { bytes }),
      uploadMedia(deps, { bytes }),
    ]);
    expect(rows).toHaveLength(1);
    expect(a.media.id).toBe(b.media.id);
  });

  it("rejects SVG and other non-images with UNSUPPORTED_TYPE, writing nothing", async () => {
    const { deps, rows, puts } = setup();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    await expect(uploadMedia(deps, { bytes: svg })).rejects.toMatchObject({
      code: "UNSUPPORTED_TYPE",
    });
    expect(rows).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("rejects files over 10 MB with TOO_LARGE", async () => {
    const { deps } = setup();
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1);
    big.set(png(1, 1));
    await expect(uploadMedia(deps, { bytes: big })).rejects.toBeInstanceOf(
      MediaError
    );
    await expect(uploadMedia(deps, { bytes: big })).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("stores no alt for blank alt text", async () => {
    const { deps } = setup();
    const { media } = await uploadMedia(deps, { bytes: png(1, 1), alt: "   " });
    expect(media.alt).toBeNull();
  });

  it.each([
    ["zero width", png(0, 10)],
    ["zero height", png(10, 0)],
    ["width over 16384", png(16_385, 10)],
    ["height over 16384", png(10, 16_385)],
  ])(
    "rejects %s with UNPROCESSABLE before writing to R2",
    async (_name, bytes) => {
      const { deps, rows, puts } = setup();
      await expect(uploadMedia(deps, { bytes })).rejects.toMatchObject({
        code: "UNPROCESSABLE",
      });
      expect(puts).toHaveLength(0);
      expect(rows).toHaveLength(0);
    }
  );

  it("rejects a JPEG whose size can't be read", async () => {
    const { deps, puts } = setup();
    // SOI, an APP0 segment, EOI: well-formed, but no frame header.
    const b = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
    ]);
    await expect(uploadMedia(deps, { bytes: b })).rejects.toMatchObject({
      code: "UNPROCESSABLE",
    });
    expect(puts).toHaveLength(0);
  });

  it("rejects over-long alt text before writing to R2", async () => {
    const { deps, rows, puts } = setup();
    await expect(
      uploadMedia(deps, { bytes: png(5, 5), alt: "x".repeat(301) })
    ).rejects.toMatchObject({ code: "INVALID" });
    expect(puts).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("strips EXIF (GPS) from a JPEG and stores, hashes and dedupes the stripped bytes", async () => {
    const { deps, stored, rows } = setup();
    const plain = fixture("jpeg");
    const withGps = withSegment(plain, exifApp1(1));
    const { media, created } = await uploadMedia(deps, { bytes: withGps });

    expect(created).toBe(true);
    expect(media.id).toBe(`${await sha256Hex(plain)}.jpg`);
    expect(media).toMatchObject({ width: 301, height: 7, mime: "image/jpeg" });
    const saved = stored.get(`media/${media.id}`)!;
    expect(saved).toEqual(plain);
    expect(Buffer.from(saved).includes("Exif")).toBe(false);
    // The same photo without metadata is a duplicate.
    expect((await uploadMedia(deps, { bytes: plain })).created).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it.each([2, 3, 6, 8])(
    "rejects a JPEG with EXIF orientation %i (stripping would show it rotated)",
    async (orientation) => {
      const { deps, puts } = setup();
      const b = withSegment(fixture("jpeg"), exifApp1(orientation));
      await expect(uploadMedia(deps, { bytes: b })).rejects.toMatchObject({
        code: "UNPROCESSABLE",
        message: expect.stringContaining("media library"),
      });
      await expect(
        uploadMedia(deps, { bytes: fixture("jpegProgressiveExif") })
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
      expect(puts).toHaveLength(0);
    }
  );

  it("names AVIF ids .avif and leaves their size unknown", async () => {
    const { deps } = setup();
    const b = new Uint8Array(32);
    b.set([0, 0, 0, 24]);
    b.set(new TextEncoder().encode("ftypavif\0\0\0\0mif1"), 4);
    const { media } = await uploadMedia(deps, { bytes: b });
    expect(media.id.endsWith(".avif")).toBe(true);
    expect(media.mime).toBe(IMAGE_TYPES.avif.mime);
    expect([media.width, media.height]).toEqual([null, null]);
  });
});

describe("listMedia", () => {
  it("lists newest first and pages with a cursor", async () => {
    const { deps, rows } = setup();
    // 45 rows; two share a timestamp so the id tiebreak matters across the page boundary.
    for (let i = 0; i < 45; i++) {
      rows.push(row(`${hex(i)}.png`, 1000 + i));
    }
    rows.push(row(`${hex(100)}.png`, 1000 + 5));

    const first = await listMedia(deps, {});
    expect(first.items).toHaveLength(MEDIA_PAGE_SIZE);
    expect(first.items[0]!.id).toBe(`${hex(44)}.png`);
    expect(first.nextCursor).not.toBeNull();

    const second = await listMedia(deps, { cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((m) => m.id);
    expect(all).toHaveLength(46);
    expect(new Set(all).size).toBe(46);
    // Same timestamp: higher id first.
    expect(all.indexOf(`${hex(100)}.png`)).toBeLessThan(
      all.indexOf(`${hex(5)}.png`)
    );
  });

  it("searches alt text, tags and id, case-insensitively", async () => {
    const { deps, rows } = setup();
    rows.push(
      row(`${hex(1)}.png`, 1, { alt: "Lakeside Bridge" }),
      row(`${hex(2)}.png`, 2, { tags: ["team", "Office"] }),
      row(`${"ab".repeat(32)}.jpg`, 3, { alt: "Logo" }),
      row(`${hex(4)}.png`, 4, { alt: "Something else" })
    );
    const ids = async (query: string) =>
      (await listMedia(deps, { query })).items.map((m) => m.id);

    expect(await ids("lake")).toEqual([`${hex(1)}.png`]);
    expect(await ids("office")).toEqual([`${hex(2)}.png`]);
    expect(await ids("abab")).toEqual([`${"ab".repeat(32)}.jpg`]);
    expect(await ids("  ")).toHaveLength(4);
    expect(await ids("nothing")).toEqual([]);
  });

  it("matches single tags, never the JSON punctuation between them", async () => {
    const { deps, rows } = setup();
    rows.push(
      row(`${hex(1)}.png`, 1, { tags: ["team", "office"] }),
      row(`${hex(2)}.png`, 2, { alt: "50% off_sale" })
    );
    const ids = async (query: string) =>
      (await listMedia(deps, { query })).items.map((m) => m.id);

    for (const q of [",", '"', "[", '","', 'm","o', '["team']) {
      expect(await ids(q)).toEqual([]);
    }
    expect(await ids("TEAM")).toEqual([`${hex(1)}.png`]);
    // No wildcards: % and _ are literal characters.
    expect(await ids("%")).toEqual([`${hex(2)}.png`]);
    expect(await ids("f_s")).toEqual([`${hex(2)}.png`]);
    expect(await ids("_")).toEqual([`${hex(2)}.png`]);
  });

  it("rejects a malformed cursor", async () => {
    const { deps } = setup();
    await expect(listMedia(deps, { cursor: "garbage" })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});

describe("getMedia", () => {
  it("returns one item's record, or null when the library has no such id", async () => {
    const { deps } = setup();
    const { media } = await uploadMedia(deps, {
      bytes: png(640, 480),
      alt: "Lake",
    });
    expect(await getMedia(deps, media.id)).toMatchObject({
      id: media.id,
      alt: "Lake",
      width: 640,
      height: 480,
    });
    expect(await getMedia(deps, `${"0".repeat(64)}.png`)).toBeNull();
  });
});

describe("updateMediaAlt", () => {
  it("updates alt and normalises tags", async () => {
    const { deps } = setup();
    const { media } = await uploadMedia(deps, { bytes: png(1, 1) });
    const updated = await updateMediaAlt(deps, {
      id: media.id,
      alt: " New alt ",
      tags: ["Team", " team ", "", "office"],
    });
    expect(updated).toMatchObject({ alt: "New alt", tags: ["team", "office"] });
    expect(
      (await listMedia(deps, { query: "office" })).items.map((m) => m.id)
    ).toEqual([media.id]);
  });

  it("leaves tags alone when they aren't passed", async () => {
    const { deps } = setup();
    const { media } = await uploadMedia(deps, { bytes: png(1, 1) });
    await updateMediaAlt(deps, { id: media.id, alt: "a", tags: ["x"] });
    expect(
      await updateMediaAlt(deps, { id: media.id, alt: "b" })
    ).toMatchObject({ alt: "b", tags: ["x"] });
  });

  it("throws NOT_FOUND for an unknown id", async () => {
    const { deps } = setup();
    await expect(
      updateMediaAlt(deps, { id: `${hex(9)}.png`, alt: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
