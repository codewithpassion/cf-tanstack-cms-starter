// biome-ignore-all lint/performance/noAwaitInLoops: chunked reads go one after the other to stay under D1's parameter limit.
// biome-ignore-all lint/style/useConsistentMethodSignatures: the port is declared with method signatures, as in the source (kept diffable).
// biome-ignore-all lint/suspicious/useAwait: async to satisfy the promise-returning port; kept as in the source.
import { and, desc, eq, inArray, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import {
  type D1Db,
  type MediaRow,
  media,
  pages,
  revisions,
  site,
  siteRevisions,
} from "./schema.ts";
import { D1_MAX_PARAMS } from "./shared.ts";

/** The media library table, plus the queries that look into pages and the site doc for a media id. */

/** Keyset position for "newest first": rows strictly older than this, ties broken by id. */
export type MediaCursor = { createdAt: number; id: string };

/**
 * What `createD1MediaRepo` implements: the same shape as `MediaRepo`, the media service's port in
 * `@repo/services`. Media is never deleted by this module.
 */
export type MediaTable = {
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

export function createD1MediaRepo(db: D1Db): MediaTable {
  return {
    async get(id) {
      const [row] = await db
        .select()
        .from(media)
        .where(eq(media.id, id))
        .limit(1);
      return row ?? null;
    },

    async insert(row) {
      await db
        .insert(media)
        .values(row)
        .onConflictDoNothing({ target: media.id });
    },

    async list({ query, after, limit, includeAgent }) {
      const conditions: (SQL | undefined)[] = [];
      if (!includeAgent) {
        conditions.push(ne(media.source, "agent"));
      }
      if (query) {
        // Plain substring (instr has no wildcards to escape), case-insensitive for ASCII like
        // SQLite's lower(). `tags` is a JSON array: each tag is matched on its own, so a query
        // can't match the JSON punctuation between them.
        const q = sql`lower(${query})`;
        conditions.push(
          sql`(instr(lower(${media.alt}), ${q}) > 0 OR instr(lower(${media.id}), ${q}) > 0 OR exists (select 1 from json_each(${media.tags}) where instr(lower(json_each.value), ${q}) > 0))`
        );
      }
      if (after) {
        const at = new Date(after.createdAt);
        conditions.push(
          or(
            lt(media.createdAt, at),
            and(eq(media.createdAt, at), lt(media.id, after.id))
          )
        );
      }
      return db
        .select()
        .from(media)
        .where(and(...conditions))
        .orderBy(desc(media.createdAt), desc(media.id))
        .limit(limit);
    },

    async update(id, patch) {
      const set =
        patch.tags === undefined
          ? { alt: patch.alt }
          : { alt: patch.alt, tags: patch.tags };
      const res = await db.update(media).set(set).where(eq(media.id, id)).run();
      return res.meta.changes === 1;
    },
  };
}

/** Width and height by media id, as stored (null when unknown). */
export type MediaSizes = Record<
  string,
  { width: number | null; height: number | null }
>;

/** Leave room under D1's parameter limit: `inArray` binds one per id. */
const IN_CHUNK = D1_MAX_PARAMS - 10;

/** Stored dimensions of the given media ids (the SEO checks need the share image's). */
export async function mediaSizes(db: D1Db, ids: string[]): Promise<MediaSizes> {
  const unique = [...new Set(ids)];
  const sizes: MediaSizes = {};
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const rows = await db
      .select({ id: media.id, width: media.width, height: media.height })
      .from(media)
      .where(inArray(media.id, unique.slice(i, i + IN_CHUNK)));
    for (const r of rows) {
      sizes[r.id] = { width: r.width, height: r.height };
    }
  }
  return sizes;
}

export type MediaUsage = {
  pages: {
    id: string;
    slug: string;
    title: string;
    status: "draft" | "published" | "archived";
    inDraft: boolean;
    inLive: boolean;
  }[];
  /** The site settings (nav, footer, default share image) use it, in the draft or live version. */
  site: boolean;
};

/**
 * Where a media item is used (/admin/media "Used on"): pages that aren't archived and the site
 * settings, in their draft or live version. Media ids are hex, so a substring match on the stored
 * JSON is exact enough. It covers every block prop (image, hero, logos, testimonials) and a
 * post's featured image, since all of them live in the page doc.
 */
export async function mediaUsage(db: D1Db, id: string): Promise<MediaUsage> {
  const live = alias(revisions, "live");
  const inDraft = sql<number>`coalesce(instr(${pages.draftDoc}, ${id}), 0) > 0`;
  const inLive = sql<number>`coalesce(instr(${live.docJson}, ${id}), 0) > 0`;
  const rows = await db
    .select({
      id: pages.id,
      slug: pages.slug,
      title: pages.title,
      status: pages.status,
      inDraft,
      inLive,
    })
    .from(pages)
    .leftJoin(live, eq(live.id, pages.liveRevId))
    .where(and(ne(pages.status, "archived"), or(inDraft, inLive)))
    .orderBy(pages.slug);
  const liveSite = alias(siteRevisions, "live_site");
  const [siteRow] = await db
    .select({ id: site.id })
    .from(site)
    .leftJoin(liveSite, eq(liveSite.id, site.liveRevId))
    .where(
      or(
        sql`coalesce(instr(${site.draftDoc}, ${id}), 0) > 0`,
        sql`coalesce(instr(${liveSite.docJson}, ${id}), 0) > 0`
      )
    )
    .limit(1);
  return {
    pages: rows.map((r) => ({
      ...r,
      inDraft: Boolean(r.inDraft),
      inLive: Boolean(r.inLive),
    })),
    site: Boolean(siteRow),
  };
}
