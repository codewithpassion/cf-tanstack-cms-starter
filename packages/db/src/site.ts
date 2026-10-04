// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim from the source (kept diffable).
// biome-ignore-all lint/suspicious/useAwait: async to satisfy the promise-returning port; kept as in the source.
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  type D1Db,
  type SiteRevisionRow,
  type SiteRow,
  site,
  siteRevisions,
} from "./schema.ts";
import { SITE_ID } from "./shared.ts";

/**
 * Storage for the site doc: the single `site` row and its append-only `site_revisions`. Same
 * rules as the page repo (pages.ts): revisions are never updated or deleted, and draft writes are
 * compare-and-set on `draft_version`.
 */

export type SiteRevisionMeta = Omit<SiteRevisionRow, "docJson">;

export type SitePatch = Partial<
  Pick<
    SiteRow,
    "draftDoc" | "draftBaseRevId" | "liveRevId" | "lastBatchId" | "updatedAt"
  >
> & {
  /** `draft_version = draft_version + 1`, computed by the database. */
  bumpDraftVersion?: boolean;
  /** Compare-and-set: commit (revisions and patch) only if `draft_version` still equals this. */
  ifDraftVersion?: number;
};

/**
 * What `createSiteD1Repo` implements: the same shape as `SiteRepo`, the site service's port in
 * `@repo/services`.
 */
export type SiteRepo = {
  /** Appends `revs` and applies `patch` atomically; false (nothing written) when `ifDraftVersion` no longer matches. */
  commit(revs: SiteRevisionRow[], patch?: SitePatch): Promise<boolean>;
  /** Inserts the row and `revs` atomically; false (nothing written) when the row already exists. */
  create(row: SiteRow, revs: SiteRevisionRow[]): Promise<boolean>;
  get(): Promise<SiteRow | null>;
  getRevision(id: string): Promise<SiteRevisionRow | null>;
  latestRevision(): Promise<SiteRevisionRow | null>;
  /** Newest first, without documents. */
  listRevisions(opts: {
    limit: number;
    offset: number;
  }): Promise<SiteRevisionMeta[]>;
};

export function createSiteD1Repo(db: D1Db): SiteRepo {
  // Revisions written in one batch share a timestamp; rowid keeps their insertion order.
  const newestFirst = [desc(siteRevisions.createdAt), desc(sql`rowid`)];
  const { docJson: _doc, ...meta } = getTableColumns(siteRevisions);
  const atVersion = (v: number) =>
    and(eq(site.id, SITE_ID), eq(site.draftVersion, v));

  return {
    async get() {
      const [row] = await db
        .select()
        .from(site)
        .where(eq(site.id, SITE_ID))
        .limit(1);
      return row ?? null;
    },

    async create(row, revs) {
      try {
        await db.batch([
          db.insert(site).values(row),
          ...revs.map((r) => db.insert(siteRevisions).values(r)),
        ]);
        return true;
      } catch (err) {
        // Someone created it first: a stale draft for the caller. Anything else is rethrown.
        const [existing] = await db
          .select({ id: site.id })
          .from(site)
          .where(eq(site.id, row.id));
        if (existing) {
          return false;
        }
        throw err;
      }
    },

    async commit(revs, patch) {
      const inserts: BatchItem<"sqlite">[] = revs.map((r) =>
        db.insert(siteRevisions).values(r)
      );
      if (!patch) {
        const [first, ...rest] = inserts;
        if (first) {
          await db.batch([first, ...rest]);
        }
        return true;
      }
      const { bumpDraftVersion, ifDraftVersion, ...fields } = patch;
      const set = bumpDraftVersion
        ? { ...fields, draftVersion: sql`${site.draftVersion} + 1` }
        : fields;
      if (ifDraftVersion === undefined) {
        await db.batch([
          db.update(site).set(set).where(eq(site.id, SITE_ID)),
          ...inserts,
        ]);
        return true;
      }
      // Same compare-and-set guard as `commit` in pages.ts: json() on malformed input raises
      // when no row has the expected version, which rolls the whole batch back.
      const guard = db
        .select({
          ok: sql`json(CASE WHEN count(*) = 1 THEN '0' ELSE 'stale draft_version' END)`,
        })
        .from(site)
        .where(atVersion(ifDraftVersion));
      const update = db.update(site).set(set).where(atVersion(ifDraftVersion));
      try {
        await db.batch([guard, update, ...inserts]);
        return true;
      } catch (err) {
        const [row] = await db
          .select({ v: site.draftVersion })
          .from(site)
          .where(eq(site.id, SITE_ID));
        if (row && row.v !== ifDraftVersion) {
          return false;
        }
        throw err;
      }
    },

    async latestRevision() {
      const [row] = await db
        .select()
        .from(siteRevisions)
        .orderBy(...newestFirst)
        .limit(1);
      return row ?? null;
    },

    listRevisions({ limit, offset }) {
      return db
        .select(meta)
        .from(siteRevisions)
        .orderBy(...newestFirst)
        .limit(limit)
        .offset(offset);
    },

    async getRevision(id) {
      const [row] = await db
        .select()
        .from(siteRevisions)
        .where(eq(siteRevisions.id, id))
        .limit(1);
      return row ?? null;
    },
  };
}
