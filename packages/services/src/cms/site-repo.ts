// biome-ignore-all lint/style/useConsistentMethodSignatures: the port keeps the source's method signatures (kept diffable), as in @repo/db.
// biome-ignore-all lint/style/noExportedImports: re-exports the db row and patch types next to the port that uses them, so services import one path.
import type { SiteRevisionRow, SiteRow } from "@repo/db";
import type { SitePatch, SiteRevisionMeta } from "@repo/db/site";

/**
 * Storage for the site doc (site-service.ts), the `SiteRepo` port: the single `site` row and its
 * append-only `site_revisions`. `createSiteD1Repo` (`@repo/db/site`) backs it with Drizzle on D1,
 * `createSiteMemoryRepo` (testing/site-memory-repo.ts) with arrays for tests. Same rules as the page
 * repo (repo.ts): revisions are never updated or deleted, and draft writes are compare-and-set on
 * `draft_version`.
 */

export type { SitePatch, SiteRevisionMeta, SiteRevisionRow, SiteRow };

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
