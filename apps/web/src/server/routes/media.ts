import {
  MEDIA_ID_RE,
  mediaKey,
  mimeForId,
} from "@repo/services/cms/media-bytes";
import { IMMUTABLE_CACHE } from "@repo/services/cms/media-service";

/**
 * Public media: `/media/<sha256>.<ext>` streamed from R2 (`env.CMS_MEDIA`). Ids are
 * content-addressed, so a URL's bytes never change and responses are cached as immutable.
 * The route (routes/media.$id.ts) passes the bucket; tests pass a fake.
 */

/** The parts of an R2 object these handlers read. `body` is absent when a precondition failed. */
export type MediaObject = {
  size: number;
  httpEtag: string;
  writeHttpMetadata: (headers: Headers) => void;
  body?: ReadableStream;
};

/** The parts of an R2 bucket these handlers call; `R2Bucket` satisfies it. */
export type MediaBucket = {
  get: (
    key: string,
    options: { onlyIf: Headers }
  ) => Promise<MediaObject | null>;
  head: (key: string) => Promise<MediaObject | null>;
};

const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

const headersFor = (id: string, obj: MediaObject): Headers => {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Set from the id as well: the upload chose the extension from the detected type.
  const mime = mimeForId(id);
  if (mime) {
    headers.set("Content-Type", mime);
  }
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
};

export const getMedia = async (
  bucket: MediaBucket,
  id: string,
  request: Request
): Promise<Response> => {
  if (!MEDIA_ID_RE.test(id)) {
    return notFound();
  }
  // Only If-None-Match is honoured: the bytes behind an id never change, so the other
  // conditionals (If-Match, If-Unmodified-Since, ...) would only need a correct 412 path.
  const onlyIf = new Headers();
  const inm = request.headers.get("If-None-Match");
  if (inm) {
    onlyIf.set("If-None-Match", inm);
  }
  const obj = await bucket.get(mediaKey(id), { onlyIf });
  if (!obj) {
    return notFound();
  }
  const headers = headersFor(id, obj);
  // A failed precondition (If-None-Match matched) returns the object without a body.
  if (!obj.body) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
};

export const headMedia = async (
  bucket: MediaBucket,
  id: string
): Promise<Response> => {
  if (!MEDIA_ID_RE.test(id)) {
    return notFound();
  }
  const obj = await bucket.head(mediaKey(id));
  if (!obj) {
    return notFound();
  }
  const headers = headersFor(id, obj);
  headers.set("Content-Length", String(obj.size));
  return new Response(null, { headers });
};
