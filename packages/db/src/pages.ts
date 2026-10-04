import { and, asc, desc, eq, getTableColumns, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  agentChangesets,
  type D1Db,
  type PageRow,
  pages,
  type RevisionRow,
  revisionLabels,
  revisions,
} from "./schema.ts";
import type { PageDoc } from "./shared.ts";

/**
 * Pages, posts and their append-only revisions on D1. Row types are inferred from the schema
 * (`PageRow`, `RevisionRow` in `schema.ts`). D1 has no interactive transactions, so multi-row
 * writes go through one `db.batch`, which is why these take a `D1Db`.
 */

export type RevisionMeta = Omit<RevisionRow, "docJson">;
/** A revision for the history list: `label` is its display label (a rename from `revision_labels` wins). */
export type RevisionListRow = RevisionMeta & { pinned: boolean };
export type PageMeta = Omit<PageRow, "draftDoc">;

export type PagePatch = Partial<
  Pick<
    PageRow,
    | "slug"
    | "status"
    | "draftDoc"
    | "draftBaseRevId"
    | "liveRevId"
    | "lastBatchId"
    | "updatedAt"
  >
> & {
  /** `draft_version = draft_version + 1`, computed by the database rather than from a stale read. */
  bumpDraftVersion?: boolean;
  /** Compare-and-set: commit (revisions and patch) only if `draft_version` still equals this. */
  ifDraftVersion?: number;
};

/**
 * A site-wide run's proposal decided in the same commit as the change that accepts it, so a page
 * never carries an accepted change whose proposal still looks pending (or the other way round).
 * The commit writes nothing when the proposal is no longer pending (`ChangesetDecided`).
 */
export type ChangesetDecision = {
  id: string;
  status: "accepted" | "partial";
  decision: unknown;
  decidedAt: Date;
};

/** `commit` with a `ChangesetDecision`: the proposal was decided already; nothing was written. */
export class ChangesetDecided extends Error {
  constructor() {
    super("This proposal was already decided.");
    this.name = "ChangesetDecided";
  }
}

/** A slug lookup only matches pages that are not archived (archived pages free their slug). */
export type PageRef = { id: string } | { slug: string };

/** A published page or post with its live revision's document. */
export type LivePage = { page: PageRow; doc: PageDoc; publishedAt: Date };

/**
 * What `createD1Repo` implements: the same shape as `CmsRepo`, the page service's port in
 * `@repo/services`. Declared here so the methods are typed without importing services.
 */
export type PageRepo = {
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
  livePages: () => Promise<LivePage[]>;
  /** Published posts with their live revision's document. */
  livePosts: () => Promise<LivePage[]>;
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

/**
 * D1 backing of the page service's `CmsRepo` port (the port type lives in `@repo/services`; this
 * satisfies it structurally). Revisions are append-only: there is deliberately no way to update
 * or delete one.
 */
export function createD1Repo(db: D1Db): PageRepo {
  // Revisions written in one batch share a timestamp; rowid keeps their insertion order.
  const newestFirst = [desc(revisions.createdAt), desc(sql`rowid`)];
  // Qualified: with revision_labels joined, a bare rowid is ambiguous.
  const newestFirstJoined = [
    desc(revisions.createdAt),
    desc(sql`"revisions".rowid`),
  ];
  const { docJson: _doc, ...revisionMeta } = getTableColumns(revisions);
  const { draftDoc: _draft, ...pageMeta } = getTableColumns(pages);
  // History rows: the rename (if any) replaces the label; no row means unpinned.
  const listed = () =>
    db
      .select({
        ...revisionMeta,
        label: sql<
          string | null
        >`coalesce(${revisionLabels.label}, ${revisions.label})`,
        pinned: sql<boolean>`coalesce(${revisionLabels.pinned}, 0)`.mapWith(
          Boolean
        ),
      })
      .from(revisions)
      .leftJoin(revisionLabels, eq(revisionLabels.revId, revisions.id));

  return {
    async findPage(ref) {
      const where =
        "id" in ref
          ? eq(pages.id, ref.id)
          : and(eq(pages.slug, ref.slug), ne(pages.status, "archived"));
      const [row] = await db.select().from(pages).where(where).limit(1);
      return row ?? null;
    },

    async insertPage(row) {
      await db.insert(pages).values(row);
    },

    listPages() {
      return db.select(pageMeta).from(pages).orderBy(desc(pages.updatedAt));
    },

    async saveDraft(id, expectedVersion, doc, updatedAt, batchId = null) {
      const res = await db
        .update(pages)
        .set({
          draftDoc: doc,
          draftVersion: expectedVersion + 1,
          lastBatchId: batchId,
          updatedAt,
        })
        .where(and(eq(pages.id, id), eq(pages.draftVersion, expectedVersion)))
        .run();
      return res.meta.changes === 1;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the three commit shapes (plain, patch, compare-and-set) share the decision guard; kept as in the source.
    async commit(pageId, revs, patch, decide) {
      const inserts: BatchItem<"sqlite">[] = revs.map((r) =>
        db.insert(revisions).values(r)
      );
      // The proposal's decision: guarded like the draft version below (a failing statement rolls the batch back).
      const decision: BatchItem<"sqlite">[] = decide
        ? [
            db
              .select({
                ok: sql`json(CASE WHEN count(*) = 1 THEN '0' ELSE 'changeset decided' END)`,
              })
              .from(agentChangesets)
              .where(
                and(
                  eq(agentChangesets.id, decide.id),
                  eq(agentChangesets.status, "pending")
                )
              ),
            db
              .update(agentChangesets)
              .set({
                status: decide.status,
                decision: decide.decision,
                decidedAt: decide.decidedAt,
              })
              .where(
                and(
                  eq(agentChangesets.id, decide.id),
                  eq(agentChangesets.status, "pending")
                )
              ),
          ]
        : [];
      const decided = async () => {
        if (!decide) {
          return false;
        }
        const [row] = await db
          .select({ status: agentChangesets.status })
          .from(agentChangesets)
          .where(eq(agentChangesets.id, decide.id));
        return row?.status !== "pending";
      };
      if (!patch) {
        const [first, ...rest] = [...decision, ...inserts];
        try {
          if (first) {
            await db.batch([first, ...rest]);
          }
        } catch (err) {
          if (await decided()) {
            // biome-ignore lint/style/useErrorCause: the batch error is the expected guard failure; ChangesetDecided is what callers act on.
            throw new ChangesetDecided();
          }
          throw err;
        }
        return true;
      }
      const { bumpDraftVersion, ifDraftVersion, ...fields } = patch;
      const set = bumpDraftVersion
        ? { ...fields, draftVersion: sql`${pages.draftVersion} + 1` }
        : fields;
      if (ifDraftVersion === undefined) {
        try {
          await db.batch([
            db.update(pages).set(set).where(eq(pages.id, pageId)),
            ...decision,
            ...inserts,
          ]);
        } catch (err) {
          if (await decided()) {
            // biome-ignore lint/style/useErrorCause: the batch error is the expected guard failure; ChangesetDecided is what callers act on.
            throw new ChangesetDecided();
          }
          throw err;
        }
        return true;
      }
      // Compare-and-set. A batch is one transaction, and a failing statement rolls the whole
      // batch back. The guard runs first and reads `draft_version` itself: an aggregate always
      // yields one row, so when no row has the expected version json() gets malformed input
      // and raises, and neither the update nor the inserts happen. (A select builder, not
      // `db.run(sql)`: drizzle can't bind a raw statement's params inside a D1 batch.)
      const guard = db
        .select({
          ok: sql`json(CASE WHEN count(*) = 1 THEN '0' ELSE 'stale draft_version' END)`,
        })
        .from(pages)
        .where(
          and(eq(pages.id, pageId), eq(pages.draftVersion, ifDraftVersion))
        );
      const update = db
        .update(pages)
        .set(set)
        .where(
          and(eq(pages.id, pageId), eq(pages.draftVersion, ifDraftVersion))
        );
      try {
        await db.batch([guard, ...decision, update, ...inserts]);
        return true;
      } catch (err) {
        // Stale only if the version really moved; anything else (a unique index, D1 itself) is rethrown.
        const [row] = await db
          .select({ v: pages.draftVersion })
          .from(pages)
          .where(eq(pages.id, pageId));
        if (row && row.v !== ifDraftVersion) {
          return false;
        }
        if (await decided()) {
          // biome-ignore lint/style/useErrorCause: the batch error is the expected guard failure; ChangesetDecided is what callers act on.
          throw new ChangesetDecided();
        }
        throw err;
      }
    },

    async latestRevision(pageId) {
      const [row] = await db
        .select()
        .from(revisions)
        .where(eq(revisions.pageId, pageId))
        .orderBy(...newestFirst)
        .limit(1);
      return row ?? null;
    },

    listRevisions(pageId) {
      return db
        .select(revisionMeta)
        .from(revisions)
        .where(eq(revisions.pageId, pageId))
        .orderBy(...newestFirst);
    },

    async getRevision(id) {
      const [row] = await db
        .select()
        .from(revisions)
        .where(eq(revisions.id, id))
        .limit(1);
      return row ?? null;
    },

    runRevisions(agentRunId) {
      return db
        .select(revisionMeta)
        .from(revisions)
        .where(
          and(eq(revisions.agentRunId, agentRunId), eq(revisions.kind, "agent"))
        )
        .orderBy(asc(revisions.createdAt), asc(sql`rowid`));
    },

    async revisionLabel(id) {
      const [row] = await listed().where(eq(revisions.id, id)).limit(1);
      return row?.label ?? null;
    },

    listRevisionPage(pageId, { limit, offset }) {
      return listed()
        .where(eq(revisions.pageId, pageId))
        .orderBy(...newestFirstJoined)
        .limit(limit)
        .offset(offset);
    },

    pinnedRevisions(pageId) {
      return listed()
        .where(
          and(eq(revisions.pageId, pageId), eq(revisionLabels.pinned, true))
        )
        .orderBy(...newestFirstJoined);
    },

    async labelRevision(revId, patch, at) {
      const set = { ...patch, updatedAt: at };
      await db
        .insert(revisionLabels)
        .values({
          revId,
          label: patch.label ?? null,
          pinned: patch.pinned ?? false,
          updatedAt: at,
        })
        .onConflictDoUpdate({ target: revisionLabels.revId, set });
    },

    async publishedSlugs(pageId) {
      const rows = await db
        .selectDistinct({
          slug: sql<string>`json_extract(${revisions.docJson}, '$.seo.slug')`,
        })
        .from(revisions)
        .where(
          and(eq(revisions.pageId, pageId), eq(revisions.kind, "published"))
        );
      return rows.map((r) => r.slug);
    },

    livePosts() {
      return (
        db
          .select({
            page: pages,
            doc: revisions.docJson,
            publishedAt: revisions.createdAt,
          })
          .from(pages)
          .innerJoin(revisions, eq(revisions.id, pages.liveRevId))
          .where(and(eq(pages.kind, "post"), eq(pages.status, "published")))
          // Newest first, ties by slug (the index sorts the same way: pages-service comparePosts).
          .orderBy(
            desc(sql`json_extract(${revisions.docJson}, '$.post.publishedAt')`),
            pages.slug
          )
      );
    },

    livePages() {
      return db
        .select({
          page: pages,
          doc: revisions.docJson,
          publishedAt: revisions.createdAt,
        })
        .from(pages)
        .innerJoin(revisions, eq(revisions.id, pages.liveRevId))
        .where(eq(pages.status, "published"));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Read queries the admin screens ran inline (posts list, SEO overview, slug checks). They read
// single JSON fields in SQLite so whole documents never leave D1.

/**
 * A field of the live version (published posts; `revisions` is joined only for those) or else of
 * the draft.
 */
const postField = (path: string) =>
  sql<
    string | null
  >`json_extract(coalesce(${revisions.docJson}, ${pages.draftDoc}), ${path})`;

/** A draft's field. */
const draftField = <T>(path: string) =>
  sql<T | null>`json_extract(${pages.draftDoc}, ${path})`;

/** One post in the /admin/posts list, fields as stored (the service shapes them). */
export type PostListRow = {
  id: string;
  slug: string;
  /** The page row's title (the fallback). */
  rowTitle: string;
  status: PageRow["status"];
  updatedAt: Date;
  title: string | null;
  seoTitle: string | null;
  category: string | null;
  publishedAt: string | null;
  author: string | null;
  /** Published, with unpublished edits in the draft. */
  draftChanges: boolean;
};

/** A non-archived page's draft SEO fields. */
export type DraftSeoRow = {
  id: string;
  status: PageRow["status"];
  currentSlug: string;
  slug: string;
  title: string;
  titleExact: boolean;
  description: string;
  shareImageId: string | null;
};

/** A non-archived page with its draft document. */
export type DraftPageRow = {
  id: string;
  kind: PageRow["kind"];
  slug: string;
  title: string;
  status: PageRow["status"];
  doc: PageDoc;
};

export function createPageQueries(db: D1Db) {
  return {
    /** The page's id, slug, status and kind, or null. */
    async pageBrief(id: string) {
      const [row] = await db
        .select({
          id: pages.id,
          kind: pages.kind,
          slug: pages.slug,
          status: pages.status,
        })
        .from(pages)
        .where(eq(pages.id, id))
        .limit(1);
      return row ?? null;
    },

    /** Every post (archived included), most recently updated first. */
    async listPosts(): Promise<PostListRow[]> {
      const rows = await db
        .select({
          id: pages.id,
          slug: pages.slug,
          rowTitle: pages.title,
          status: pages.status,
          updatedAt: pages.updatedAt,
          title: postField("$.post.title"),
          seoTitle: postField("$.seo.title"),
          category: postField("$.post.category"),
          publishedAt: postField("$.post.publishedAt"),
          author: postField("$.post.author"),
          // Both are stored as the service serialised them (validated docs, same key order), so text equality is document equality.
          draftChanges: sql<number>`${revisions.docJson} is not null and ${revisions.docJson} != ${pages.draftDoc}`,
        })
        .from(pages)
        .leftJoin(
          revisions,
          and(eq(revisions.id, pages.liveRevId), eq(pages.status, "published"))
        )
        .where(eq(pages.kind, "post"))
        .orderBy(desc(pages.updatedAt));
      return rows.map((r) => ({ ...r, draftChanges: Boolean(r.draftChanges) }));
    },

    /**
     * Every non-archived page's draft title, description, slug and share image id, in one query
     * that reads only those fields (the SEO tab asks on open and after each publish).
     */
    async draftSeoSummaries(): Promise<DraftSeoRow[]> {
      const rows = await db
        .select({
          id: pages.id,
          status: pages.status,
          currentSlug: pages.slug,
          slug: draftField<string>("$.seo.slug"),
          title: draftField<string>("$.seo.title"),
          // JSON true comes back as 1.
          titleExact: draftField<number | boolean>("$.seo.titleExact"),
          description: draftField<string>("$.seo.description"),
          shareImageId: draftField<string>("$.seo.social.image.mediaId"),
        })
        .from(pages)
        .where(ne(pages.status, "archived"));
      return rows.flatMap((r) =>
        typeof r.title === "string" && typeof r.slug === "string"
          ? [
              {
                id: r.id,
                status: r.status,
                currentSlug: r.currentSlug,
                slug: r.slug,
                title: r.title,
                titleExact: r.titleExact === 1 || r.titleExact === true,
                description:
                  typeof r.description === "string" ? r.description : "",
                shareImageId:
                  typeof r.shareImageId === "string" ? r.shareImageId : null,
              },
            ]
          : []
      );
    },

    /** Every non-archived page with its draft document, in one query (the /admin/seo overview runs every check). */
    async draftPages(): Promise<DraftPageRow[]> {
      const rows = await db
        .select({
          id: pages.id,
          kind: pages.kind,
          slug: pages.slug,
          title: pages.title,
          status: pages.status,
          draftDoc: pages.draftDoc,
        })
        .from(pages)
        .where(ne(pages.status, "archived"));
      return rows.flatMap((r) =>
        r.draftDoc
          ? [
              {
                id: r.id,
                kind: r.kind,
                slug: r.slug,
                title: r.title,
                status: r.status,
                doc: r.draftDoc,
              },
            ]
          : []
      );
    },

    /**
     * Non-archived pages at `slug`: their current slug (publishing checks this) or their draft's
     * (it would clash when that draft is published).
     */
    slugOwners(slug: string): Promise<{ id: string; title: string }[]> {
      return db
        .select({ id: pages.id, title: pages.title })
        .from(pages)
        .where(
          and(
            ne(pages.status, "archived"),
            or(eq(pages.slug, slug), eq(draftField<string>("$.seo.slug"), slug))
          )
        );
    },
  };
}
