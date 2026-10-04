import { MAX_MEDIA_BYTES } from "@repo/services/cms/media-bytes";
import { MediaError, type MediaInfo } from "@repo/services/cms/media-service";

/**
 * Media upload, POST /admin/api/media (routes/admin.api.media.ts): multipart `file` (+ optional
 * `alt`) through the Worker, never a presigned URL. 201 for a new file, 200 when the same bytes are
 * already stored (the stored row is returned unchanged, including its alt text). The route injects
 * the admin check and the media service, so this module never touches `cloudflare:workers`.
 */

export type MediaUploadDeps = {
  /** Resolves to the admin, or throws a `Response` (401/403/503) that is returned as is. */
  assertAdmin: (request: Request) => Promise<{ userId: string }>;
  /** The media service's `uploadMedia`, built for this user. */
  upload: (
    userId: string,
    input: { bytes: Uint8Array; alt: string | null }
  ) => Promise<{ media: MediaInfo; created: boolean }>;
};

const STATUS: Record<MediaError["code"], number> = {
  TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  INVALID: 400,
  NOT_FOUND: 404,
  UNPROCESSABLE: 422,
  IN_USE: 409,
};

const error = (status: number, message: string) =>
  Response.json({ ok: false, message }, { status });

// Multipart framing (boundaries, part headers, the alt field) on top of the file itself.
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_BODY = MAX_MEDIA_BYTES + MULTIPART_OVERHEAD;
const DIGITS = /^\d+$/;
const TOO_LARGE = "Images can be at most 10 MB.";
const NOT_MULTIPART = "Expected multipart/form-data with a `file` field.";

/**
 * Same-origin check: `Sec-Fetch-Site` must be `same-origin`; browsers that don't send it must send
 * an `Origin` equal to this request's origin. Runs before anything else.
 */
const isSameOrigin = (request: Request): boolean => {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) {
    return site === "same-origin";
  }
  return request.headers.get("Origin") === new URL(request.url).origin;
};

/** The body, read while counting bytes; null as soon as it passes `max` (the rest is never buffered). */
export const readBody = async (
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: a stream is read chunk by chunk, in order.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

type Upload = { userId: string; file: File; alt: FormDataEntryValue | null };

/** Origin and admin checks, then the multipart body read under the size cap. A Response is an early answer. */
const readUpload = async (
  request: Request,
  assertAdmin: MediaUploadDeps["assertAdmin"]
): Promise<Response | Upload> => {
  if (!isSameOrigin(request)) {
    return error(403, "Cross-origin uploads are not allowed.");
  }
  let userId: string;
  try {
    ({ userId } = await assertAdmin(request));
  } catch (res) {
    if (res instanceof Response) {
      return res;
    }
    throw res;
  }

  const declared = request.headers.get("Content-Length");
  if (declared === null || !DIGITS.test(declared)) {
    return error(411, "Content-Length is required.");
  }
  if (Number(declared) > MAX_BODY) {
    return error(413, TOO_LARGE);
  }

  const body = request.body
    ? await readBody(request.body, MAX_BODY)
    : new Uint8Array();
  if (!body) {
    return error(413, TOO_LARGE);
  }

  let form: FormData;
  try {
    const contentType = request.headers.get("Content-Type") ?? "";
    form = await new Response(body, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    return error(400, NOT_MULTIPART);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return error(400, NOT_MULTIPART);
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return error(413, TOO_LARGE);
  }
  return { userId, file, alt: form.get("alt") };
};

export const handleMediaUpload = async (
  request: Request,
  deps: MediaUploadDeps
): Promise<Response> => {
  const upload = await readUpload(request, deps.assertAdmin);
  if (upload instanceof Response) {
    return upload;
  }
  const { userId, file, alt } = upload;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { media, created } = await deps.upload(userId, {
      bytes,
      alt: typeof alt === "string" ? alt : null,
    });
    // {id, url, width, height, mime, alt, tags, createdAt} plus whether this call stored it.
    return Response.json(
      { ...media, created },
      { status: created ? 201 : 200 }
    );
  } catch (e) {
    if (e instanceof MediaError) {
      return error(STATUS[e.code], e.message);
    }
    throw e;
  }
};
