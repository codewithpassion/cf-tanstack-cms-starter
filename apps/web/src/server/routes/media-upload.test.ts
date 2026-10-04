import { describe, expect, it } from "bun:test";
import { MediaError, type MediaInfo } from "@repo/services/cms/media-service";
import { handleMediaUpload, type MediaUploadDeps } from "./media-upload";

const URL_ = "https://example.com/admin/api/media";

const MEDIA: MediaInfo = {
  id: `${"b".repeat(64)}.png`,
  url: `/media/${"b".repeat(64)}.png`,
  width: 1,
  height: 1,
  mime: "image/png",
  alt: "alt",
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const BOUNDARY = "test-boundary-1";

/**
 * A same-origin multipart request with an accurate Content-Length. Encoded by hand: under bun test
 * a FormData body's Content-Type (with the boundary) is not reliably available.
 */
const multipart = (
  fields: { file?: Uint8Array; alt?: string },
  headers: Record<string, string> = {}
): Request => {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  if (fields.alt !== undefined) {
    parts.push(
      encoder.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="alt"\r\n\r\n${fields.alt}\r\n`
      )
    );
  }
  if (fields.file) {
    parts.push(
      encoder.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      fields.file,
      encoder.encode("\r\n")
    );
  }
  parts.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return new Request(URL_, {
    method: "POST",
    body,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      "Content-Length": String(body.byteLength),
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
  });
};

const deps = (overrides: Partial<MediaUploadDeps> = {}) => {
  const calls: { userId: string; alt: string | null; size: number }[] = [];
  const value: MediaUploadDeps = {
    assertAdmin: () => Promise.resolve({ userId: "user_1" }),
    upload: (userId, input) => {
      calls.push({ userId, alt: input.alt, size: input.bytes.byteLength });
      return Promise.resolve({ media: MEDIA, created: true });
    },
    ...overrides,
  };
  return { deps: value, calls };
};

const png = () => new Uint8Array([1, 2, 3]);

describe("POST /admin/api/media", () => {
  it("rejects a cross-origin request before the admin check", async () => {
    let checked = false;
    const { deps: d } = deps({
      assertAdmin: () => {
        checked = true;
        return Promise.resolve({ userId: "user_1" });
      },
    });
    const res = await handleMediaUpload(
      multipart({ file: png() }, { "Sec-Fetch-Site": "cross-site" }),
      d
    );
    expect(res.status).toBe(403);
    expect(checked).toBe(false);
  });

  it("returns the admin check's Response without reading the body", async () => {
    let read = false;
    // highWaterMark 0: the stream pulls only when someone reads it.
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          read = true;
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const request = new Request(URL_, {
      method: "POST",
      body,
      headers: { Origin: "https://example.com", "Content-Length": "10" },
      duplex: "half",
    } as RequestInit);
    const { deps: d, calls } = deps({
      assertAdmin: () => {
        throw Response.json({ ok: false }, { status: 401 });
      },
    });
    const res = await handleMediaUpload(request, d);
    expect(res.status).toBe(401);
    expect(read).toBe(false);
    expect(calls).toEqual([]);
  });

  it("requires a Content-Length", async () => {
    const req = multipart({ file: png() });
    const headers = new Headers(req.headers);
    headers.delete("Content-Length");
    const res = await handleMediaUpload(
      new Request(URL_, {
        method: "POST",
        body: await req.arrayBuffer(),
        headers,
      }),
      deps().deps
    );
    expect(res.status).toBe(411);
  });

  it("answers 413 when the declared length is over the cap", async () => {
    const res = await handleMediaUpload(
      multipart({ file: png() }, { "Content-Length": "99999999" }),
      deps().deps
    );
    expect(res.status).toBe(413);
  });

  it("answers 400 without a file field", async () => {
    const res = await handleMediaUpload(multipart({ alt: "x" }), deps().deps);
    expect(res.status).toBe(400);
  });

  it("uploads as the admin with the alt text: 201 new, 200 duplicate", async () => {
    const { deps: d, calls } = deps();
    const res = await handleMediaUpload(
      multipart({ file: png(), alt: "A cat" }),
      d
    );
    expect(res.status).toBe(201);
    const uploaded: unknown = await res.json();
    expect(uploaded).toEqual({ ...MEDIA, created: true });
    expect(calls).toEqual([{ userId: "user_1", alt: "A cat", size: 3 }]);

    const dup = await handleMediaUpload(multipart({ file: png() }), {
      ...d,
      upload: () => Promise.resolve({ media: MEDIA, created: false }),
    });
    expect(dup.status).toBe(200);
  });

  it("maps a MediaError to its status", async () => {
    const { deps: d } = deps({
      upload: () =>
        Promise.reject(new MediaError("UNSUPPORTED_TYPE", "Not an image.")),
    });
    const res = await handleMediaUpload(multipart({ file: png() }), d);
    expect(res.status).toBe(415);
    const failed: unknown = await res.json();
    expect(failed).toEqual({ ok: false, message: "Not an image." });
  });
});
