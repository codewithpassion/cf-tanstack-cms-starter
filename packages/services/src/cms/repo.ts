// biome-ignore-all lint/style/noExportedImports: re-exports the db row and patch types next to the port that uses them, so services import one path.
import type { PageRow, RevisionRow } from "@repo/db";
import type {
  ChangesetDecision,
  PageMeta,
  PagePatch,
  PageRef,
  RevisionListRow,
  RevisionMeta,
} from "@repo/db/pages";
import type { PageDoc } from "@repo/db/shared";

/**
 * Storage the page service needs, the `CmsRepo` port. `createD1Repo` (`@repo/db/pages`) backs it
 * with Drizzle on D1 (`ports.typecheck.ts` checks that it fits); `createMemoryRepo`
 * (testing/memory-repo.ts) backs it with arrays for tests. Revisions are append-only: there is
 * deliberately no way to update or delete one.
 *
 * Row and patch types come from `@repo/db` (services are server-only). `ChangesetDecided` is the
 * class the D1 repo throws, so `instanceof` in the page service matches it.
 */

// biome-ignore lint/performance/noBarrelFile: one import path for the page service's storage types.
export { ChangesetDecided } from "@repo/db/pages";
export type {
  ChangesetDecision,
  PageMeta,
  PagePatch,
  PageRef,
  PageRow,
  RevisionListRow,
  RevisionMeta,
  RevisionRow,
};

export type CmsRepo = {
  /**
   * Appends `revs` (in order) and applies `patch` to the page, atomically. Returns false, having
   * written nothing, when `patch.ifDraftVersion` no longer matches. With `decide`, the proposal's
   * decision is written in the same transaction (throws `ChangesetDecided`, having written
   * nothing, when it is no longer pending).
   */
  commit: (
    pageId: string,
    revs: RevisionRow[],
    patch?: PagePatch,
    decide?: ChangesetDecision
  ) => Promise<boolean>;
  findPage: (ref: PageRef) => Promise<PageRow | null>;
  getRevision: (id: string) => Promise<RevisionRow | null>;
  insertPage: (row: PageRow) => Promise<void>;
  /** Upserts the revision's rename/pin row; fields left out keep their value (new rows: no label, unpinned). */
  labelRevision: (
    revId: string,
    patch: { label?: string | null; pinned?: boolean },
    at: Date
  ) => Promise<void>;
  latestRevision: (pageId: string) => Promise<RevisionRow | null>;
  /** Every page and post, archived included, without draft documents; most recently updated first. */
  listPages: () => Promise<PageMeta[]>;
  /** Newest first, `limit` rows from `offset`, with display labels and pins. */
  listRevisionPage: (
    pageId: string,
    opts: { limit: number; offset: number }
  ) => Promise<RevisionListRow[]>;
  /** Newest first, without documents. */
  listRevisions: (pageId: string) => Promise<RevisionMeta[]>;
  /** Published pages and posts with their live revision's document (for KV `pages:index`). */
  livePages: () => Promise<
    { page: PageRow; doc: PageDoc; publishedAt: Date }[]
  >;
  /** Published posts with their live revision's document. */
  livePosts: () => Promise<
    { page: PageRow; doc: PageDoc; publishedAt: Date }[]
  >;
  /** The page's pinned revisions, newest first. */
  pinnedRevisions: (pageId: string) => Promise<RevisionListRow[]>;
  /** Distinct `seo.slug`s of the page's `published` revisions. */
  publishedSlugs: (pageId: string) => Promise<string[]>;
  /** The revision's display label: its rename (`revision_labels`) if any, else the label it was saved with. */
  revisionLabel: (id: string) => Promise<string | null>;
  /** The `agent` revisions a site-wide run's accepted changes became, on every page, oldest first. */
  runRevisions: (agentRunId: string) => Promise<RevisionMeta[]>;
  /**
   * Compare-and-set: writes and bumps `draft_version` only if it still equals `expectedVersion`.
   * Records `batchId` (null when the save has none) as the page's `last_batch_id`.
   */
  saveDraft: (
    id: string,
    expectedVersion: number,
    doc: PageDoc,
    updatedAt: Date,
    batchId?: string | null
  ) => Promise<boolean>;
};
