import { describe, expect, it } from "bun:test";
import {
  getMedia,
  headMedia,
  type MediaBucket,
  type MediaObject,
} from "./media";

const ID = `${"a".repeat(64)}.png`;
const ETAG = '"etag-1"';

const object = (body?: string): MediaObject => ({
  size: 3,
  httpEtag: ETAG,
  writeHttpMetadata: (headers) =>
    headers.set("Content-Type", "application/octet-stream"),
  body: body === undefined ? undefined : (new Response(body).body ?? undefined),
});

/** Records the keys asked for; `get` answers 304-style (no body) when If-None-Match matches. */
const fakeBucket = (stored: boolean) => {
  const calls: string[] = [];
  const bucket: MediaBucket = {
    get: (key, { onlyIf }) => {
      calls.push(`get ${key}`);
      if (!stored) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        object(onlyIf.get("If-None-Match") === ETAG ? undefined : "png")
      );
    },
    head: (key) => {
      calls.push(`head ${key}`);
      return Promise.resolve(stored ? object() : null);
    },
  };
  return { bucket, calls };
};

const request = (headers?: HeadersInit) =>
  new Request(`https://example.com/media/${ID}`, { headers });

describe("GET /media/$id", () => {
  it("answers 404 for a malformed id without reading the bucket", async () => {
    const { bucket, calls } = fakeBucket(true);
    for (const id of ["nope.png", `${"A".repeat(64)}.png`, "../secret"]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose; three cheap calls.
      const res = await getMedia(bucket, id, request());
      expect(res.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("answers 404 for an id that is not stored", async () => {
    const { bucket } = fakeBucket(false);
    expect((await getMedia(bucket, ID, request())).status).toBe(404);
  });

  it("streams the bytes from media/<id> as immutable, typed from the id", async () => {
    const { bucket, calls } = fakeBucket(true);
    const res = await getMedia(bucket, ID, request());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png");
    expect(calls).toEqual([`get media/${ID}`]);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("ETag")).toBe(ETAG);
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("answers 304 without a body when If-None-Match matches", async () => {
    const { bucket } = fakeBucket(true);
    const res = await getMedia(bucket, ID, request({ "If-None-Match": ETAG }));
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("ETag")).toBe(ETAG);
  });
});

describe("HEAD /media/$id", () => {
  it("returns the headers and length without a body", async () => {
    const { bucket, calls } = fakeBucket(true);
    const res = await headMedia(bucket, ID);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(calls).toEqual([`head media/${ID}`]);
  });

  it("answers 404 for a bad or missing id", async () => {
    expect((await headMedia(fakeBucket(true).bucket, "x")).status).toBe(404);
    expect((await headMedia(fakeBucket(false).bucket, ID)).status).toBe(404);
  });
});
