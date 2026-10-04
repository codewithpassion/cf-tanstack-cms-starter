// biome-ignore-all lint/style/noExportedImports: re-exports `MediaRow` for callers of the service.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; constructor parameter properties as in the source.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning interfaces and callbacks; kept as in the source.

import { mediaUrl } from "@repo/cms-core/media";
import type { MediaRow } from "@repo/db";
import { bindDeps } from "./bind";
import {
  AGENT_SCREENS_PREFIX,
  detectImageType,
  imageDimensions,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_EDGE,
  mediaIdFor,
  mediaKey,
  sha256Hex,
  stripJpegMetadata,
} from "./media-bytes";
import type { BlobPort, MediaCursor, MediaRepo } from "./media-repo";

/**
 * Media library (docs/cms-plan.md §3.1 media table, §3.6 Media). Plain functions over injected
 * storage: `createD1MediaRepo` (`@repo/db/media`) for D1, `createMemoryMediaRepo` (testing/) for tests.
 * Media is never deleted (plan §3.2); a future delete must pass `assertMediaDeletable` and
 * `assertBlobDeletable` first.
 */

/** What the API and server functions return. */
export type MediaInfo = {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  mime: string;
  alt: string | null;
  tags: string[];
  createdAt: string;
};

export type { MediaRow };

export type MediaDeps = {
  repo: MediaRepo;
  blobs: BlobPort;
  now?: () => number;
};

/** UNPROCESSABLE: a supported type whose contents can't be accepted (unreadable size, rotated JPEG). */
export type MediaErrorCode =
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "NOT_FOUND"
  | "INVALID"
  | "UNPROCESSABLE"
  | "IN_USE";

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export const MEDIA_PAGE_SIZE = 40;
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// Matches the `alt` limit of image refs in blocks and SEO (app/cms/blocks/image.tsx, app/cms/seo/schema.ts).
const MAX_ALT = 300;
const MAX_TAGS = 20;
const MAX_TAG = 40;

export function toMediaInfo(row: MediaRow): MediaInfo {
  return {
    id: row.id,
    url: mediaUrl(row.id),
    width: row.width,
    height: row.height,
    mime: row.mime,
    alt: row.alt,
    tags: row.tags ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Stores an upload, deduplicated by content. The R2 write comes first (identical bytes make it
 * idempotent) so a row never points at a missing object. `created` is false for a duplicate.
 *
 * JPEGs lose their EXIF/XMP/IPTC segments (GPS, camera details) before hashing, so what is stored
 * and deduplicated is the stripped file. The media library re-encodes JPEGs in the browser, which
 * bakes in the EXIF orientation; a JPEG that arrives here still carrying a non-default orientation
 * is rejected, because stripping it would silently show the photo rotated or mirrored.
 * Everything is validated before the R2 write, so a rejected upload leaves no object behind.
 * `source` records where the image came from: an upload, a share-image screenshot or FLUX.
 */
export async function uploadMedia(
  deps: MediaDeps,
  input: { bytes: Uint8Array; alt?: string | null; source?: MediaRow["source"] }
): Promise<{ media: MediaInfo; created: boolean }> {
  let { bytes } = input;
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new MediaError("TOO_LARGE", "Images can be at most 10 MB.");
  }
  const type = detectImageType(bytes);
  if (!type) {
    throw new MediaError(
      "UNSUPPORTED_TYPE",
      "Only JPEG, PNG, WebP, GIF and AVIF images can be uploaded."
    );
  }

  if (type.mime === "image/jpeg") {
    const stripped = stripJpegMetadata(bytes);
    if (!stripped) {
      throw new MediaError("UNPROCESSABLE", "Could not read this JPEG file.");
    }
    if (stripped.orientation !== 1) {
      throw new MediaError(
        "UNPROCESSABLE",
        "Please upload via the media library (rotated photo)."
      );
    }
    bytes = stripped.bytes;
  }
  const size = imageDimensions(bytes, type);
  // AVIF sizes aren't parsed (always null); every other type must have a readable, sane size.
  if (
    type.mime !== "image/avif" &&
    !(size && validEdge(size.width) && validEdge(size.height))
  ) {
    throw new MediaError(
      "UNPROCESSABLE",
      `Could not read the image size, or it is over ${MAX_MEDIA_EDGE} pixels.`
    );
  }
  const alt = normalizeAlt(input.alt);

  const sha256 = await sha256Hex(bytes);
  const id = mediaIdFor(sha256, type);
  const existing = await deps.repo.get(id);
  if (existing) {
    return { media: toMediaInfo(existing), created: false };
  }

  const key = mediaKey(id);
  await deps.blobs.put(key, bytes, {
    httpMetadata: { contentType: type.mime, cacheControl: IMMUTABLE_CACHE },
  });
  await deps.repo.insert({
    id,
    r2Key: key,
    sha256,
    mime: type.mime,
    width: size?.width ?? null,
    height: size?.height ?? null,
    alt,
    tags: null,
    source: input.source ?? "upload",
    createdAt: new Date((deps.now ?? Date.now)()),
  });
  // Re-read: a concurrent upload of the same file may have inserted first.
  const row = await deps.repo.get(id);
  if (!row) {
    throw new Error(`media ${id} missing after insert`);
  }
  return { media: toMediaInfo(row), created: true };
}

export async function listMedia(
  deps: MediaDeps,
  input: { query?: string; cursor?: string; includeAgent?: boolean }
): Promise<{ items: MediaInfo[]; nextCursor: string | null }> {
  const query = input.query?.trim() || undefined;
  const after = input.cursor ? decodeCursor(input.cursor) : undefined;
  const rows = await deps.repo.list({
    query,
    after,
    limit: MEDIA_PAGE_SIZE + 1,
    includeAgent: input.includeAgent,
  });
  const page = rows.slice(0, MEDIA_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map(toMediaInfo),
    nextCursor:
      rows.length > MEDIA_PAGE_SIZE && last ? encodeCursor(last) : null,
  };
}

/** One media item, or null when no row has this id (deleted, or never uploaded here). */
export async function getMedia(
  deps: MediaDeps,
  id: string
): Promise<MediaInfo | null> {
  const row = await deps.repo.get(id);
  return row ? toMediaInfo(row) : null;
}

export async function updateMediaAlt(
  deps: MediaDeps,
  input: { id: string; alt: string; tags?: string[] }
): Promise<MediaInfo> {
  const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
  const ok = await deps.repo.update(input.id, {
    alt: normalizeAlt(input.alt),
    tags,
  });
  const row = ok ? await deps.repo.get(input.id) : null;
  if (!row) {
    throw new MediaError("NOT_FOUND", `No media with id ${input.id}.`);
  }
  return toMediaInfo(row);
}

/** Where a media item is still referenced, for the deletion guard. */
export type MediaReferences = {
  /** Image blocks in AI agent transcripts that point at this media id. */
  agentTranscriptRefs(mediaId: string): Promise<number>;
};

/**
 * Throws IN_USE when a media item can't be deleted: an agent conversation references it. Agent
 * transcripts are append-only and replayed to the model on every request (Claude Opus 5.5 ties
 * its thinking to the exact conversation), so a missing image would change history.
 */
export async function assertMediaDeletable(
  refs: MediaReferences,
  mediaId: string
): Promise<void> {
  const n = await refs.agentTranscriptRefs(mediaId);
  if (n > 0) {
    throw new MediaError(
      "IN_USE",
      `This image is part of ${n} AI agent message${n === 1 ? "" : "s"} and can't be deleted.`
    );
  }
}

/** Throws IN_USE for R2 objects that must never be deleted: the agent's screenshots (`AGENT_SCREENS_PREFIX`). */
export function assertBlobDeletable(key: string): void {
  if (key.startsWith(AGENT_SCREENS_PREFIX)) {
    throw new MediaError(
      "IN_USE",
      "Agent screenshots are part of AI agent conversations and are never deleted."
    );
  }
}

const validEdge = (n: number) => n > 0 && n <= MAX_MEDIA_EDGE;

function normalizeAlt(alt: string | null | undefined): string | null {
  const trimmed = alt?.trim() ?? "";
  if (trimmed.length > MAX_ALT) {
    throw new MediaError(
      "INVALID",
      `Alt text can be at most ${MAX_ALT} characters.`
    );
  }
  return trimmed || null;
}

function normalizeTags(tags: string[]): string[] | null {
  const clean = [
    ...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ];
  if (clean.length > MAX_TAGS || clean.some((t) => t.length > MAX_TAG)) {
    throw new MediaError(
      "INVALID",
      `At most ${MAX_TAGS} tags of up to ${MAX_TAG} characters.`
    );
  }
  return clean.length ? clean : null;
}

export function encodeCursor(row: Pick<MediaRow, "createdAt" | "id">): string {
  return `${row.createdAt.getTime()}:${row.id}`;
}

export function decodeCursor(cursor: string): MediaCursor {
  const m = /^(\d+):(.+)$/.exec(cursor);
  if (!m) {
    throw new MediaError("INVALID", "Bad cursor.");
  }
  return { createdAt: Number(m[1]), id: m[2]! };
}

/** The media service with its ports bound: build it once from `{ repo, blobs }`. */
export const createMediaService = (deps: MediaDeps) =>
  bindDeps(deps, { uploadMedia, listMedia, getMedia, updateMediaAlt });
