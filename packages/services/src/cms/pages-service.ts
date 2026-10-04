// biome-ignore-all lint/style/noExportedImports: re-exports `PageSummary` (cms-core) as the service always has.
import { MAX_DOC_BYTES } from "@repo/cms-core/limits";
import { applyOps, OpError } from "@repo/cms-core/ops/apply-ops";
import { deepEqual } from "@repo/cms-core/ops/json";
import { parseOps } from "@repo/cms-core/ops/schema";
import { type LabelFor, summarizeChange } from "@repo/cms-core/ops/summary";
import type { PageSummary } from "@repo/cms-core/page-summary";
import { isValidSlug } from "@repo/cms-core/paths";
import {
  isPostSlug,
  type PostSummary,
  postReadingTime,
  postTitle,
  withReadingTime,
} from "@repo/cms-core/posts";
import { isReservedSlug } from "@repo/cms-core/reserved";
import type {
  Op,
  PageDoc,
  PageKind,
  ValidationResult,
} from "@repo/cms-core/types";
import { nanoid } from "nanoid";
import { bindDeps } from "./bind";
import type { KvPort } from "./kv";
import {
  ChangesetDecided,
  type ChangesetDecision,
  type CmsRepo,
  type PageMeta,
  type PagePatch,
  type PageRow,
  type RevisionListRow,
  type RevisionMeta,
  type RevisionRow,
} from "./repo";

/**
 * Page lifecycle: drafts, revisions, publish to KV (docs/cms-plan.md §3.1, §3.2, §3.5, §3.8).
 * Plain functions over injected dependencies; server functions and routes wrap these later.
 * Revisions are append-only. D1 is the source of truth; KV holds what the public site serves.
 */

export type ServiceDeps = {
  repo: CmsRepo;
  kv: KvPort;
  validate: (doc: unknown) => ValidationResult;
  labelFor: LabelFor;
  now?: () => number;
  genId?: () => string;
  /** Recorded as `author` on the revisions this call writes (the admin's Clerk user id). */
  author?: string | null;
  /**
   * Hook for document-level migrations of an old revision before a restore validates it (block
   * props are already migrated per block by `validate`, via the registry's `migrate`). Identity
   * when unset.
   */
  migrateDoc?: (doc: unknown) => unknown;
};

export type CmsErrorCode =
  | "NOT_FOUND"
  | "STALE_DRAFT"
  | "INVALID_DOC"
  | "INVALID_OPS"
  | "INVALID_SLUG"
  | "DOC_TOO_LARGE"
  | "SLUG_TAKEN"
  | "SLUG_RESERVED"
  | "NOT_PUBLISHED"
  | "ARCHIVED"
  | "NOT_ARCHIVED"
  | "BAD_KIND"
  | "LIVE_CHANGED";

export class CmsError extends Error {
  readonly code: CmsErrorCode;
  readonly details?: unknown;

  constructor(code: CmsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CmsError";
    this.code = code;
    this.details = details;
  }
}

/** Value of KV `page:<slug>`. */
export type LivePage = {
  revId: string;
  publishedAt: string;
  kind: PageKind;
  doc: PageDoc;
};

/** One entry of KV `pages:index` is a `PageSummary` (cms-core): every live page and post, sorted by slug. */
export type { PageSummary };

/** `live: false` means D1 committed but the KV write failed: show "published, not live yet" + Retry (republish). */
export type PublishResult = { ok: true; live: boolean; revId: string };

const BLOCK_PATH_RE = /^blocks(?:\[(\d+)\]|\.(\d+))/;
const SEO_PATH_RE = /^seo\.([A-Za-z]+)/;

export const AUTOSNAPSHOT_AFTER_MS = 5 * 60 * 1000;
/** Serialised (UTF-8) document size cap (shared with the editor, which checks it before each edit). */
// biome-ignore lint/performance/noBarrelFile: the editor imports the cap with the service, as in the source.
export { MAX_DOC_BYTES } from "@repo/cms-core/limits";

// ---------------------------------------------------------------------------------------------
// Pages and drafts

/** `slug` is authoritative: it overwrites `doc.seo.slug`. Posts live under `blog/` and carry `post` metadata. */
export async function createPage(
  d: ServiceDeps,
  input: { kind: PageKind; slug: string; title: string; doc: PageDoc }
): Promise<PageRow> {
  checkKind(input.kind, input.slug, input.doc);
  checkReserved(input.kind, input.slug);
  if (await d.repo.findPage({ slug: input.slug })) {
    throw slugTaken(input.slug);
  }
  const doc = validated(d, {
    ...input.doc,
    seo: { ...input.doc.seo, slug: input.slug },
  });
  const page: PageRow = {
    id: newId(d),
    kind: input.kind,
    slug: input.slug,
    title: input.title,
    status: "draft",
    draftDoc: doc,
    draftVersion: 0,
    draftBaseRevId: null,
    liveRevId: null,
    lastBatchId: null,
    updatedAt: new Date(now(d)),
  };
  await d.repo.insertPage(page);
  return page;
}

/** Every page and post (archived included), most recently updated first, without drafts. */
export function listPages(d: ServiceDeps): Promise<PageMeta[]> {
  return d.repo.listPages();
}

/**
 * Whether a new page of `kind` can take `slug`: the same rules `createPage` enforces, without
 * creating anything. Throws `INVALID_SLUG`, `BAD_KIND`, `SLUG_RESERVED` or `SLUG_TAKEN`.
 */
export async function checkSlugAvailable(
  d: ServiceDeps,
  kind: PageKind,
  slug: string
): Promise<void> {
  if (!isValidSlug(slug)) {
    throw new CmsError(
      "INVALID_SLUG",
      "Use lowercase words separated by - and /",
      [
        {
          path: "seo.slug",
          message: "Use lowercase words separated by - and /",
        },
      ]
    );
  }
  const inBlog = slug.startsWith("blog/");
  if (kind === "page" && inBlog) {
    throw new CmsError(
      "BAD_KIND",
      `slugs under blog/ are for posts (got "${slug}")`
    );
  }
  if (kind === "post" && !isPostSlug(slug)) {
    throw new CmsError(
      "BAD_KIND",
      `a post needs a slug of blog/ and one more segment, like blog/my-post (got "${slug}")`
    );
  }
  checkReserved(kind, slug);
  if (await d.repo.findPage({ slug })) {
    throw slugTaken(slug);
  }
}

/** By id, or by slug among pages that are not archived. */
export function getPage(
  d: ServiceDeps,
  ref: { id: string } | { slug: string }
): Promise<PageRow | null> {
  return d.repo.findPage(ref);
}

/**
 * Applies `ops` to the draft the client last saw (`draftVersion`), validates, saves, and maybe
 * writes an autosnapshot. Throws `STALE_DRAFT` if someone saved in between ("reload draft"), and
 * `ARCHIVED` for an archived page. `ops` is untrusted input: it is checked against `opsSchema`
 * (`INVALID_OPS`), which requires explicit `_key`s on inserted and replacing blocks (use the
 * normalized ops `applyOps` returns).
 *
 * `batchId` makes a save idempotent: the editor resends a batch whose response it never got with
 * the same id and version. If that batch was the last one applied (and nothing saved since), the
 * current draft is returned instead of a spurious `STALE_DRAFT`.
 */
export async function applyDraftOps(
  d: ServiceDeps,
  pageId: string,
  draftVersion: number,
  ops: unknown,
  batchId?: string
): Promise<{
  draftVersion: number;
  doc: PageDoc;
  snapshotRevId: string | null;
}> {
  const parsed = parseOps(ops);
  if (!parsed.ok) {
    throw new CmsError("INVALID_OPS", "ops failed validation", parsed.errors);
  }
  const page = await requirePage(d, pageId);
  if (page.status === "archived") {
    throw archived(page.id);
  }
  if (page.draftVersion !== draftVersion) {
    if (
      batchId &&
      page.lastBatchId === batchId &&
      page.draftVersion === draftVersion + 1
    ) {
      return {
        draftVersion: page.draftVersion,
        doc: draftOf(page),
        snapshotRevId: null,
      };
    }
    throw staleDraft(page.draftVersion);
  }
  const before = draftOf(page);
  const doc = validated(d, applied(before, parsed.ops));
  const at = new Date(now(d));
  const latest = await d.repo.latestRevision(pageId);

  // Autosnapshot of the draft as it was BEFORE this edit (the end state of the previous editing
  // session), when there's no revision yet, or the latest is over 5 minutes old and differs.
  // Written in the same commit as the draft, so a failed save leaves neither.
  let snap: RevisionRow | null = null;
  if (
    !latest ||
    (at.getTime() - latest.createdAt.getTime() > AUTOSNAPSHOT_AFTER_MS &&
      !deepEqual(latest.docJson, before))
  ) {
    snap = revision(d, page, "autosnapshot", before, page.draftBaseRevId, at, {
      summary: summarizeChange(
        latest?.docJson ?? emptied(before),
        before,
        d.labelFor
      ),
    });
  }
  const committed = await d.repo.commit(pageId, snap ? [snap] : [], {
    draftDoc: doc,
    lastBatchId: batchId ?? null,
    updatedAt: at,
    bumpDraftVersion: true,
    ifDraftVersion: draftVersion,
    ...(snap && { draftBaseRevId: snap.id }),
  });
  if (!committed) {
    throw staleDraft();
  }
  return {
    draftVersion: draftVersion + 1,
    doc,
    snapshotRevId: snap?.id ?? null,
  };
}

export async function archivePage(
  d: ServiceDeps,
  pageId: string
): Promise<{ ok: true; synced: boolean }> {
  return takeDown(d, await requirePage(d, pageId), "archived");
}

/**
 * Brings an archived page back as an unpublished draft at its slug (docs/2026-10-03-mcp-server-prd.md
 * §7). Archiving freed the slug, so it must still be free (the same checks as a new page: another
 * page may have taken it, or a code route reserved it since); `SLUG_TAKEN` etc. otherwise, and
 * `NOT_ARCHIVED` for a page that isn't archived. Its draft and history are as they were; it was
 * taken off the site when archived, so nothing is published here.
 */
export async function unarchivePage(
  d: ServiceDeps,
  pageId: string
): Promise<PageRow> {
  const page = await requirePage(d, pageId);
  if (page.status !== "archived") {
    throw new CmsError("NOT_ARCHIVED", `/${page.slug} isn't archived.`);
  }
  await checkSlugAvailable(d, page.kind, page.slug);
  const at = new Date(now(d));
  await d.repo.commit(page.id, [], { status: "draft", updatedAt: at });
  return { ...page, status: "draft", updatedAt: at };
}

// ---------------------------------------------------------------------------------------------
// Revisions

/**
 * "Save version…": a `named` revision of the current draft. With `draftVersion` (the draft the
 * client last saw), it is `STALE_DRAFT` unless that is still the draft, so the version is exactly
 * what the client saved.
 */
export async function saveVersion(
  d: ServiceDeps,
  pageId: string,
  label: string,
  draftVersion?: number
): Promise<RevisionRow> {
  const page = await requirePage(d, pageId);
  if (page.status === "archived") {
    throw archived(page.id);
  }
  if (draftVersion !== undefined && page.draftVersion !== draftVersion) {
    throw staleDraft(page.draftVersion);
  }
  const doc = draftOf(page);
  const latest = await d.repo.latestRevision(pageId);
  const rev = revision(
    d,
    page,
    "named",
    doc,
    page.draftBaseRevId,
    new Date(now(d)),
    {
      label,
      summary: summarizeChange(
        latest?.docJson ?? emptied(doc),
        doc,
        d.labelFor
      ),
    }
  );
  const committed = await d.repo.commit(pageId, [rev], {
    draftBaseRevId: rev.id,
    ...(draftVersion !== undefined && { ifDraftVersion: draftVersion }),
  });
  if (!committed) {
    throw staleDraft();
  }
  return rev;
}

export function listRevisions(
  d: ServiceDeps,
  pageId: string
): Promise<RevisionMeta[]> {
  return d.repo.listRevisions(pageId);
}

export function getRevision(
  d: ServiceDeps,
  revId: string
): Promise<RevisionRow | null> {
  return d.repo.getRevision(revId);
}

/**
 * One page of the history panel: `limit` revisions (newest first, display labels applied) from
 * `offset`, and on the first page every pinned revision. Revisions are only ever appended, so a
 * later page may repeat entries (never skip any); callers dedupe by id.
 */
export async function revisionHistory(
  d: ServiceDeps,
  pageId: string,
  opts: { limit: number; offset: number }
): Promise<{
  page: PageRow;
  revisions: RevisionListRow[];
  pinned: RevisionListRow[];
  hasMore: boolean;
}> {
  const page = await requirePage(d, pageId);
  const rows = await d.repo.listRevisionPage(pageId, {
    limit: opts.limit + 1,
    offset: opts.offset,
  });
  const pinned = opts.offset === 0 ? await d.repo.pinnedRevisions(pageId) : [];
  return {
    page,
    revisions: rows.slice(0, opts.limit),
    pinned,
    hasMore: rows.length > opts.limit,
  };
}

/** A revision of this page (`NOT_FOUND` for a revision of another page). */
export function pageRevision(
  d: ServiceDeps,
  pageId: string,
  revId: string
): Promise<RevisionRow> {
  return requireRevision(d, pageId, revId);
}

/**
 * Rename (`label`; null drops the new name, an empty string is refused by callers) or pin a
 * revision. Stored beside the revision (`revision_labels`), which itself never changes.
 */
export async function labelRevision(
  d: ServiceDeps,
  pageId: string,
  revId: string,
  patch: { label?: string | null; pinned?: boolean }
): Promise<void> {
  await requireRevision(d, pageId, revId);
  await d.repo.labelRevision(revId, patch, new Date(now(d)));
}

/** A block left out of a restore because it no longer passes validation. */
export type DroppedBlock = { key: string; type: string };

export type RestoreResult = {
  revId: string;
  draftVersion: number;
  doc: PageDoc;
  /** Blocks of the old version that fail today's validation, left out. */
  dropped: DroppedBlock[];
  /** Top-level SEO fields that fail today's validation, taken from the current draft instead. */
  seoReplaced: string[];
};

/**
 * Makes an old revision the draft by appending a `restore` revision; nothing is removed. If the
 * current draft isn't captured by the latest revision yet, it is snapshotted first so it stays
 * in history (same commit). `draftVersion` is the draft the client last saw (`STALE_DRAFT`
 * otherwise). A revision that no longer passes validation is restored without its invalid blocks
 * and with the draft's values for its invalid SEO fields; the result lists both.
 */
export async function restore(
  d: ServiceDeps,
  pageId: string,
  revId: string,
  draftVersion: number,
  /** "Revert this run": `note` leads the `restore` revision's summary (the revision isn't tagged with the run: it isn't the run's change). */
  opts: { note?: string } = {}
): Promise<RestoreResult> {
  const page = await requirePage(d, pageId);
  if (page.status === "archived") {
    throw archived(page.id);
  }
  if (page.draftVersion !== draftVersion) {
    throw staleDraft(page.draftVersion);
  }
  const source = await requireRevision(d, pageId, revId);
  const draft = draftOf(page);
  const { doc, dropped, seoReplaced } = restorable(d, source.docJson, draft);
  const name = await revisionName(d, source);
  const notes = [
    ...(dropped.length
      ? [`dropped ${dropped.map((b) => d.labelFor(b.type)).join(", ")}`]
      : []),
    ...(seoReplaced.length
      ? [`SEO ${seoReplaced.join(", ")} kept from the draft`]
      : []),
  ];
  const summary = `${opts.note ? `${opts.note}: ` : ""}Restored ${name}${notes.length ? ` (${notes.join("; ")})` : ""} · ${summarizeChange(draft, doc, d.labelFor)}`;
  const committed = await commitRestore(
    d,
    page,
    draft,
    doc,
    summary,
    draftVersion
  );
  return { ...committed, doc, dropped, seoReplaced };
}

/**
 * Copies one block from a revision into the draft: replaces it if the key exists, else re-inserts
 * it at its old index. Like `restore`: the current draft is snapshotted first when History doesn't
 * have it, and a `restore` revision records the change, all in one commit. `draftVersion` is the
 * draft the client last saw (`STALE_DRAFT` otherwise).
 */
export async function restoreBlock(
  d: ServiceDeps,
  pageId: string,
  revId: string,
  blockKey: string,
  draftVersion: number
): Promise<{ revId: string; draftVersion: number; doc: PageDoc }> {
  const page = await requirePage(d, pageId);
  if (page.status === "archived") {
    throw archived(page.id);
  }
  if (page.draftVersion !== draftVersion) {
    throw staleDraft(page.draftVersion);
  }
  const source = await requireRevision(d, pageId, revId);
  const oldIndex = source.docJson.blocks.findIndex((b) => b._key === blockKey);
  const block = source.docJson.blocks[oldIndex];
  if (!block) {
    throw new CmsError(
      "NOT_FOUND",
      `revision ${revId} has no block ${blockKey}`
    );
  }
  const draft = draftOf(page);
  const op: Op = draft.blocks.some((b) => b._key === blockKey)
    ? { op: "replace", key: blockKey, block }
    : {
        op: "insert",
        at: { index: Math.min(oldIndex, draft.blocks.length) },
        block,
      };
  const doc = validated(d, applied(draft, [op]));
  const summary = `Restored block ${d.labelFor(block._type)} from ${await revisionName(d, source)}`;
  const committed = await commitRestore(
    d,
    page,
    draft,
    doc,
    summary,
    draftVersion
  );
  return { ...committed, doc };
}

/**
 * Applies an accepted agent proposal of a site-wide run in one commit (docs/cms-plan.md §3.2,
 * Phase 6): the draft as it was is snapshotted first when History doesn't have it, then an `agent`
 * revision of the result, tagged with the run and parented on that "before" revision, becomes the
 * draft. "Revert this run" restores each page to the parent of the run's first revision on it,
 * which is therefore exactly the draft before the run touched it. `draftVersion` is the draft the
 * caller saw (`STALE_DRAFT` otherwise). `decide`: the proposal's decision, written in the same
 * commit (`LIVE_CHANGED` when it was decided meanwhile; nothing is written then).
 */
export async function commitAgentChange(
  d: ServiceDeps,
  pageId: string,
  draftVersion: number,
  ops: Op[],
  opts: {
    summary: string;
    agentRunId: string;
    decide?: Omit<ChangesetDecision, "decidedAt">;
  }
): Promise<{
  revId: string;
  beforeRevId: string;
  draftVersion: number;
  doc: PageDoc;
}> {
  const page = await requirePage(d, pageId);
  if (page.status === "archived") {
    throw archived(page.id);
  }
  if (page.draftVersion !== draftVersion) {
    throw staleDraft(page.draftVersion);
  }
  const draft = draftOf(page);
  const doc = validated(d, applied(draft, ops));
  const at = new Date(now(d));
  const latest = await d.repo.latestRevision(page.id);
  const revs: RevisionRow[] = [];
  const current = latest && deepEqual(latest.docJson, draft) ? latest : null;
  const before =
    current ??
    revision(d, page, "autosnapshot", draft, page.draftBaseRevId, at, {
      summary: summarizeChange(
        latest?.docJson ?? emptied(draft),
        draft,
        d.labelFor
      ),
    });
  if (!current) {
    revs.push(before);
  }
  const change = summarizeChange(draft, doc, d.labelFor);
  const rev = revision(d, page, "agent", doc, before.id, at, {
    summary: `Agent: ${opts.summary}${change ? ` · ${change}` : ""}`.slice(
      0,
      1000
    ),
    agentRunId: opts.agentRunId,
  });
  revs.push(rev);
  let committed: boolean;
  try {
    committed = await d.repo.commit(
      page.id,
      revs,
      {
        draftDoc: doc,
        draftBaseRevId: rev.id,
        bumpDraftVersion: true,
        ifDraftVersion: draftVersion,
        updatedAt: at,
      },
      opts.decide && {
        ...opts.decide,
        decision: { ...(opts.decide.decision as object), revId: rev.id },
        decidedAt: at,
      }
    );
  } catch (err) {
    if (err instanceof ChangesetDecided) {
      // biome-ignore lint/style/useErrorCause: CmsError is an expected, user-facing failure; its details carry what matters.
      throw new CmsError("LIVE_CHANGED", err.message);
    }
    throw err;
  }
  if (!committed) {
    throw staleDraft();
  }
  return {
    revId: rev.id,
    beforeRevId: before.id,
    draftVersion: draftVersion + 1,
    doc,
  };
}

/** Snapshot of the draft (when the latest revision isn't it) + the `restore` revision + the new draft: one commit. */
async function commitRestore(
  d: ServiceDeps,
  page: PageRow,
  draft: PageDoc,
  doc: PageDoc,
  summary: string,
  draftVersion: number
): Promise<{ revId: string; draftVersion: number }> {
  const at = new Date(now(d));
  const latest = await d.repo.latestRevision(page.id);
  const revs: RevisionRow[] = [];
  let parent = page.draftBaseRevId;
  if (!(latest && deepEqual(latest.docJson, draft))) {
    const snap = revision(d, page, "autosnapshot", draft, parent, at, {
      summary: summarizeChange(
        latest?.docJson ?? emptied(draft),
        draft,
        d.labelFor
      ),
    });
    revs.push(snap);
    parent = snap.id;
  }
  const restored = revision(d, page, "restore", doc, parent, at, { summary });
  revs.push(restored);
  const committed = await d.repo.commit(page.id, revs, {
    draftDoc: doc,
    draftBaseRevId: restored.id,
    bumpDraftVersion: true,
    ifDraftVersion: draftVersion,
    updatedAt: at,
  });
  if (!committed) {
    throw staleDraft();
  }
  return { revId: restored.id, draftVersion: draftVersion + 1 };
}

/** `"Label"` (its current name, renames included), or the version's date. */
async function revisionName(d: ServiceDeps, rev: RevisionRow): Promise<string> {
  const label = await d.repo.revisionLabel(rev.id);
  return label ? `"${label}"` : `version from ${rev.createdAt.toISOString()}`;
}

/**
 * An old revision's document made valid for today: migrated (`d.migrateDoc`), then blocks that
 * fail validation dropped and SEO fields that fail it replaced by the draft's. Anything else
 * invalid (the envelope, the size) is `INVALID_DOC`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one validate-and-repair loop, kept as in the source.
function restorable(
  d: ServiceDeps,
  raw: PageDoc,
  draft: PageDoc
): { doc: PageDoc; dropped: DroppedBlock[]; seoReplaced: string[] } {
  let doc = structuredClone(
    (d.migrateDoc ?? ((x: unknown) => x))(raw)
  ) as PageDoc;
  const dropped: DroppedBlock[] = [];
  const seoReplaced: string[] = [];
  // Each pass fixes every error it can attribute; a second pass catches what a fix uncovered.
  for (let pass = 0; pass < 3; pass += 1) {
    const result = d.validate(doc);
    if (result.ok) {
      break;
    }
    const badBlocks = new Set<number>();
    const badSeo = new Set<string>();
    for (const { path } of result.errors) {
      const block = BLOCK_PATH_RE.exec(path);
      const seo = SEO_PATH_RE.exec(path);
      if (block) {
        badBlocks.add(Number(block[1] ?? block[2]));
      } else if (seo?.[1] && seo[1] !== "slug") {
        badSeo.add(seo[1]);
      }
    }
    if (!(badBlocks.size || badSeo.size)) {
      break;
    }
    if (badBlocks.size && Array.isArray(doc.blocks)) {
      for (const [i, b] of doc.blocks.entries()) {
        if (badBlocks.has(i)) {
          dropped.push({ key: String(b?._key), type: String(b?._type) });
        }
      }
      doc = { ...doc, blocks: doc.blocks.filter((_, i) => !badBlocks.has(i)) };
    }
    if (badSeo.size && doc.seo) {
      const seo = { ...doc.seo } as Record<string, unknown>;
      for (const key of badSeo) {
        const value = (draft.seo as Record<string, unknown>)[key];
        if (value === undefined) {
          delete seo[key];
        } else {
          seo[key] = value;
        }
        if (!seoReplaced.includes(key)) {
          seoReplaced.push(key);
        }
      }
      doc = { ...doc, seo: seo as PageDoc["seo"] };
    }
  }
  return { doc: validated(d, doc), dropped, seoReplaced };
}

// ---------------------------------------------------------------------------------------------
// Publishing

/**
 * Publishes the draft the client last saw (`draftVersion`, else `STALE_DRAFT`): one D1 batch
 * (revision + live pointer), then KV. `expectedLiveRevId`, when given, is the live revision the
 * caller compared against (null: the page wasn't live); `LIVE_CHANGED` if it moved since.
 */
export async function publish(
  d: ServiceDeps,
  pageId: string,
  draftVersion: number,
  opts: { expectedLiveRevId?: string | null } = {}
): Promise<PublishResult> {
  const page = await requirePage(d, pageId);
  if (page.draftVersion !== draftVersion) {
    throw staleDraft(page.draftVersion);
  }
  // The publish dialog showed a diff against this live revision (null: not live); a publish or
  // rollback since then makes that diff wrong, so the user must look again.
  if (opts.expectedLiveRevId !== undefined) {
    const liveNow = page.status === "published" ? page.liveRevId : null;
    if (liveNow !== opts.expectedLiveRevId) {
      throw new CmsError(
        "LIVE_CHANGED",
        "The live page changed since you opened Publish; check the changes again."
      );
    }
  }
  const doc = validated(d, draftOf(page));
  return publishDoc(d, page, doc, {
    parentRevId: page.draftBaseRevId,
    fromDraft: true,
  });
}

/**
 * Publishes an earlier `published` revision's document as a new `published` revision, at the
 * page's current slug (a version published under an older slug doesn't move the page back). The
 * draft is untouched. Only for a page that is live now (`NOT_PUBLISHED` otherwise: publishing is
 * the way back), and only to a revision that was published (`NOT_PUBLISHED` for any other kind).
 */
export async function rollbackLive(
  d: ServiceDeps,
  pageId: string,
  revId: string
): Promise<PublishResult> {
  const page = await requirePage(d, pageId);
  if (page.status === "archived") {
    throw archived(page.id);
  }
  const source = await requireRevision(d, pageId, revId);
  if (page.status !== "published" || !page.liveRevId) {
    throw new CmsError(
      "NOT_PUBLISHED",
      "The page isn't published, so there's no live version to roll back. Publish it instead."
    );
  }
  if (source.kind !== "published") {
    throw new CmsError(
      "NOT_PUBLISHED",
      "Only a version that was published can be rolled back to"
    );
  }
  const doc = validated(d, {
    ...source.docJson,
    seo: { ...source.docJson.seo, slug: page.slug },
  });
  return publishDoc(d, page, doc, {
    parentRevId: page.liveRevId,
    fromDraft: false,
    summaryPrefix: "Rolled back live",
  });
}

/** Rewrites KV from the live revision in D1 (the Retry after `live: false`). */
export async function republish(
  d: ServiceDeps,
  pageId: string
): Promise<PublishResult> {
  const page = await requirePage(d, pageId);
  if (page.status !== "published" || !page.liveRevId) {
    throw new CmsError("NOT_PUBLISHED", `page ${pageId} is not published`);
  }
  const rev = await requireRevision(d, pageId, page.liveRevId);
  const live = await syncLive(d, page, rev);
  return { ok: true, live, revId: rev.id };
}

/** Takes the page off the public site. */
export async function unpublish(
  d: ServiceDeps,
  pageId: string
): Promise<{ ok: true; synced: boolean }> {
  return takeDown(d, await requirePage(d, pageId), "draft");
}

async function publishDoc(
  d: ServiceDeps,
  page: PageRow,
  doc: PageDoc,
  opts: {
    parentRevId: string | null;
    fromDraft: boolean;
    summaryPrefix?: string;
  }
): Promise<PublishResult> {
  if (page.status === "archived") {
    throw archived(page.id);
  }
  const { slug } = doc.seo;
  checkKind(page.kind, slug, doc);
  checkReserved(page.kind, slug);
  const owner = await d.repo.findPage({ slug });
  if (owner && owner.id !== page.id) {
    throw slugTaken(slug);
  }
  const liveDoc = page.liveRevId
    ? (await d.repo.getRevision(page.liveRevId))?.docJson
    : undefined;
  const at = new Date(now(d));
  const diff = summarizeChange(liveDoc ?? emptied(doc), doc, d.labelFor);
  const rev = revision(d, page, "published", doc, opts.parentRevId, at, {
    summary: opts.summaryPrefix ? `${opts.summaryPrefix} · ${diff}` : diff,
  });
  const patch: PagePatch = {
    liveRevId: rev.id,
    status: "published",
    slug,
    updatedAt: at,
  };
  if (opts.fromDraft) {
    patch.draftBaseRevId = rev.id;
    patch.ifDraftVersion = page.draftVersion; // publish exactly the draft that was read
  }
  if (!(await d.repo.commit(page.id, [rev], patch))) {
    throw staleDraft();
  }

  const published: PageRow = {
    ...page,
    slug,
    status: "published",
    liveRevId: rev.id,
  };
  const live = await syncLive(d, published, rev);
  return { ok: true, live, revId: rev.id };
}

/**
 * Writes KV for a live revision: `page:<slug>`, and drops any `redirect:<slug>` that would shadow
 * it. Every other slug this page was ever published under gets `redirect:<old>` → the current
 * slug and loses its `page:` key, unless another page is live there now. Recomputed from D1 each
 * time, so a retry or any later publish repairs an earlier failed write, and old slugs always
 * point straight at the current one (no chains). Rebuilds `pages:index` (and `posts:index` for a
 * post). Never throws.
 */
async function syncLive(
  d: ServiceDeps,
  page: PageRow,
  rev: RevisionRow
): Promise<boolean> {
  try {
    const value: LivePage = {
      revId: rev.id,
      publishedAt: rev.createdAt.toISOString(),
      kind: page.kind,
      doc: rev.docJson,
    };
    await d.kv.put(`page:${page.slug}`, JSON.stringify(value));
    await d.kv.delete(`redirect:${page.slug}`);
    for (const oldSlug of await d.repo.publishedSlugs(page.id)) {
      if (oldSlug === page.slug) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a handful of old slugs, each a lookup then KV writes in order.
      const owner = await d.repo.findPage({ slug: oldSlug });
      if (owner && owner.id !== page.id && owner.status === "published") {
        continue;
      }
      await d.kv.put(`redirect:${oldSlug}`, page.slug);
      await d.kv.delete(`page:${oldSlug}`);
    }
    await writePagesIndex(d);
    if (page.kind === "post") {
      await writePostsIndex(d);
    }
    return true;
  } catch {
    return false;
  }
}

async function takeDown(
  d: ServiceDeps,
  page: PageRow,
  status: "draft" | "archived"
): Promise<{ ok: true; synced: boolean }> {
  if (page.status === "archived") {
    throw archived(page.id);
  }
  await d.repo.commit(page.id, [], {
    status,
    liveRevId: null,
    updatedAt: new Date(now(d)),
  });
  // No live-revision check: a take-down whose KV step failed left D1 updated, and running it again
  // must still clear the page store. Slugs are unique, so `page:<slug>` can only be this page's.
  try {
    await d.kv.delete(`page:${page.slug}`);
    // Old slugs would otherwise redirect into a 404. Only redirects still pointing here are
    // ours: another page may have taken one over since.
    for (const oldSlug of await d.repo.publishedSlugs(page.id)) {
      if (
        oldSlug !== page.slug &&
        // biome-ignore lint/performance/noAwaitInLoops: a handful of old slugs, read then deleted in order.
        (await d.kv.get(`redirect:${oldSlug}`)) === page.slug
      ) {
        await d.kv.delete(`redirect:${oldSlug}`);
      }
    }
    await writePagesIndex(d);
    if (page.kind === "post") {
      await writePostsIndex(d);
    }
    return { ok: true, synced: true };
  } catch {
    return { ok: true, synced: false };
  }
}

/** Rebuilt from D1 every time, never patched, so it can't drift. */
async function writePagesIndex(d: ServiceDeps): Promise<void> {
  const live = await d.repo.livePages();
  const index = live.map(({ page, doc, publishedAt }) =>
    pageSummaryOf(page, doc, publishedAt)
  );
  index.sort((a, b) => compareSlugs(a.slug, b.slug));
  await d.kv.put("pages:index", JSON.stringify(index));
}

/** A live page's `pages:index` entry (`publishedAt`: when its live revision was published). */
export function pageSummaryOf(
  page: { slug: string; kind: PageKind },
  doc: PageDoc,
  publishedAt: Date
): PageSummary {
  const { seo } = doc;
  const entry: PageSummary = {
    slug: page.slug,
    kind: page.kind,
    title: postTitle(doc),
    description: seo.description,
    updatedAt: publishedAt.toISOString(),
    index: seo.robots.index,
    sitemapInclude: seo.sitemap.include,
    llmsInclude: seo.llms.include,
  };
  if (seo.llms.summary) {
    entry.llmsSummary = seo.llms.summary;
  }
  if (doc.post) {
    entry.lastmod = doc.post.modifiedAt ?? doc.post.publishedAt;
  }
  return entry;
}

/** Rebuilt from D1 every time, never patched, so it can't drift. */
async function writePostsIndex(d: ServiceDeps): Promise<void> {
  const posts = await d.repo.livePosts();
  const index = posts.map(({ page, doc, publishedAt }) =>
    postSummaryOf(page.slug, doc, publishedAt)
  );
  index.sort(comparePosts);
  await d.kv.put("posts:index", JSON.stringify(index));
}

/** A live post's `posts:index` entry (`publishedAt`: when its live revision was published, the date when the post has none). */
export function postSummaryOf(
  slug: string,
  doc: PageDoc,
  publishedAt: Date
): PostSummary {
  const { post } = doc;
  // biome-ignore-start lint/suspicious/noUnnecessaryConditions: `post` is optional (a page in the index has none).
  const entry: PostSummary = {
    slug,
    title: postTitle(doc),
    // An empty excerpt falls back to the meta description, so a card is never blank.
    excerpt: post?.excerpt || doc.seo.description,
    publishedAt: post?.publishedAt || publishedAt.toISOString(),
    author: post?.author ?? "",
    readingTime: post ? postReadingTime(post) : 0,
    category: post?.category ?? "",
    tags: post?.tags ?? [],
  };
  // biome-ignore-end lint/suspicious/noUnnecessaryConditions: as above.
  if (post?.featuredImage) {
    entry.featuredImage = post.featuredImage;
  }
  return entry;
}

/** Newest first by `publishedAt`; posts published the same moment by slug, so the order is stable. */
export function comparePosts(
  a: { slug: string; publishedAt: string },
  b: { slug: string; publishedAt: string }
): number {
  return (
    Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
    compareSlugs(a.slug, b.slug)
  );
}

/** Code-unit order (not locale order), as `Array.prototype.sort` without a comparator. */
function compareSlugs(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Helpers

const now = (d: ServiceDeps) => (d.now ?? Date.now)();
const newId = (d: ServiceDeps) => (d.genId ?? (() => nanoid()))();

function revision(
  d: ServiceDeps,
  page: PageRow,
  kind: RevisionRow["kind"],
  doc: PageDoc,
  parentRevId: string | null,
  at: Date,
  extra: { label?: string; summary: string; agentRunId?: string }
): RevisionRow {
  return {
    id: newId(d),
    pageId: page.id,
    parentRevId,
    docJson: doc,
    kind,
    label: extra.label ?? null,
    summary: extra.summary,
    author: d.author ?? null,
    agentRunId: extra.agentRunId ?? null,
    createdAt: at,
  };
}

async function requirePage(d: ServiceDeps, id: string): Promise<PageRow> {
  const page = await d.repo.findPage({ id });
  if (!page) {
    throw new CmsError("NOT_FOUND", `page ${id} not found`);
  }
  return page;
}

async function requireRevision(
  d: ServiceDeps,
  pageId: string,
  revId: string
): Promise<RevisionRow> {
  const rev = await d.repo.getRevision(revId);
  if (!rev || rev.pageId !== pageId) {
    throw new CmsError(
      "NOT_FOUND",
      `revision ${revId} not found for page ${pageId}`
    );
  }
  return rev;
}

function draftOf(page: PageRow): PageDoc {
  if (!page.draftDoc) {
    throw new CmsError("NOT_FOUND", `page ${page.id} has no draft`);
  }
  return page.draftDoc;
}

function validated(d: ServiceDeps, doc: unknown): PageDoc {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
  } catch {
    // biome-ignore lint/style/useErrorCause: CmsError is an expected, user-facing failure; its details carry what matters.
    throw new CmsError("INVALID_DOC", "document could not be serialised");
  }
  if (bytes > MAX_DOC_BYTES) {
    throw new CmsError(
      "DOC_TOO_LARGE",
      `document is ${bytes} bytes; the limit is ${MAX_DOC_BYTES}`,
      { bytes }
    );
  }
  const result = d.validate(doc);
  if (!result.ok) {
    throw new CmsError(
      "INVALID_DOC",
      "document failed validation",
      result.errors
    );
  }
  // A post's reading time is computed from its body on every save, never typed (§3.8).
  return withReadingTime(result.doc);
}

/** `applyOps`, with an op that can't apply (unknown key, bad position, …) reported as `INVALID_OPS`. */
function applied(doc: PageDoc, ops: Op[]): PageDoc {
  try {
    return applyOps(doc, ops).doc;
  } catch (err) {
    if (err instanceof OpError) {
      // biome-ignore lint/style/useErrorCause: CmsError is an expected, user-facing failure; its details carry what matters.
      throw new CmsError("INVALID_OPS", err.message, {
        opIndex: err.opIndex,
        code: err.code,
      });
    }
    if (err instanceof RangeError) {
      // biome-ignore lint/style/useErrorCause: CmsError is an expected, user-facing failure; its details carry what matters.
      throw new CmsError("INVALID_OPS", "ops could not be applied", {
        message: err.message,
      });
    }
    throw err;
  }
}

/** Baseline for summarising a page's first revision: same doc, no blocks. */
const emptied = (doc: PageDoc): PageDoc => ({ ...doc, blocks: [] });

/** Posts live at `blog/<one segment>` and carry `post` metadata; pages stay out of `blog/`. */
function checkKind(kind: PageKind, slug: string, doc: PageDoc) {
  const inBlog = slug.startsWith("blog/");
  if (kind === "post" && !(isPostSlug(slug) && doc.post)) {
    throw new CmsError(
      "BAD_KIND",
      `a post needs a slug of blog/ and one more segment, and post metadata (got "${slug}")`
    );
  }
  if (kind === "page" && inBlog) {
    throw new CmsError(
      "BAD_KIND",
      `slugs under blog/ are for posts (got "${slug}")`
    );
  }
}

/** Code routes own these slugs (app/cms/reserved.ts). Posts are exempt: they own `blog/`. */
function checkReserved(kind: PageKind, slug: string) {
  if (kind === "page" && isReservedSlug(slug)) {
    throw new CmsError(
      "SLUG_RESERVED",
      `"${slug}" belongs to a page built into the site; pick another slug`
    );
  }
}

const archived = (id: string) =>
  new CmsError("ARCHIVED", `page ${id} is archived`);
const slugTaken = (slug: string) =>
  new CmsError("SLUG_TAKEN", `slug "${slug}" is already in use`);
const staleDraft = (current?: number) =>
  new CmsError(
    "STALE_DRAFT",
    "the draft changed since it was loaded; reload it",
    { current }
  );

/** The page service with its ports bound: build it once from `{ repo, kv, validate, labelFor, ... }`. */
export const createPagesService = (deps: ServiceDeps) =>
  bindDeps(deps, {
    createPage,
    listPages,
    checkSlugAvailable,
    getPage,
    applyDraftOps,
    archivePage,
    unarchivePage,
    saveVersion,
    listRevisions,
    getRevision,
    revisionHistory,
    pageRevision,
    labelRevision,
    restore,
    restoreBlock,
    commitAgentChange,
    publish,
    rollbackLive,
    republish,
    unpublish,
  });
