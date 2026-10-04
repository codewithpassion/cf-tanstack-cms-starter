// biome-ignore-all lint/style/useConsistentMethodSignatures: the port keeps the source's method signatures (kept diffable), as in @repo/db.
import type { MediaRow } from "@repo/db";

/** Storage ports of the media service: the `media` table and the R2 bucket. */

/** Keyset position for "newest first": rows strictly older than this, ties broken by id. */
export type MediaCursor = { createdAt: number; id: string };

export type MediaRepo = {
  get(id: string): Promise<MediaRow | null>;
  /** Does nothing if the id already exists (concurrent upload of the same file). */
  insert(row: MediaRow): Promise<void>;
  /**
   * Newest first (`created_at` desc, `id` desc). `query` matches alt, tags or id, case-insensitively.
   * Images the AI agent rendered (`source` "agent") only with `includeAgent`.
   */
  list(opts: {
    query?: string;
    after?: MediaCursor;
    limit: number;
    includeAgent?: boolean;
  }): Promise<MediaRow[]>;
  /** Returns false when no row has this id. */
  update(
    id: string,
    patch: { alt: string | null; tags?: string[] | null }
  ): Promise<boolean>;
};

/** The part of an R2 bucket the upload needs. `R2Bucket` fits it. */
export type BlobPort = {
  put(
    key: string,
    value: Uint8Array,
    opts: { httpMetadata: { contentType: string; cacheControl: string } }
  ): Promise<unknown>;
};
