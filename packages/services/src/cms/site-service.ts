import { deepEqual } from "@repo/cms-core/ops/json";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { defaultSiteDoc } from "@repo/cms-core/site/defaults";
import { validateSiteDoc } from "@repo/cms-core/site/schema";
import { siteChanges, summarizeSiteChange } from "@repo/cms-core/site/summary";
import type { LiveSite, SiteDoc } from "@repo/cms-core/site/types";
import { SITE_ID } from "@repo/db/shared";
import { nanoid } from "nanoid";

import { bindDeps } from "./bind";
import type { KvPort } from "./kv";
import { AUTOSNAPSHOT_AFTER_MS, CmsError } from "./pages-service";
import { SITE_KV_KEY } from "./read-site";
import type { SiteRepo, SiteRevisionMeta, SiteRevisionRow } from "./site-repo";

/**
 * Site doc lifecycle (docs/cms-plan.md §3.7 "Site doc", §3.2 versioning): draft autosave with
 * autosnapshots, publish to KV `site`, restore as a new revision. Mirrors pages-service.ts for one
 * fixed document. Until the first save there is no row and the draft is `defaultSiteDoc(config)`;
 * the first save records those defaults as the first revision, so they can
 * always be restored.
 */

export type SiteDeps = {
  repo: SiteRepo;
  kv: KvPort;
  /** Name, origin and Search Console property; the defaults a fresh site starts from are built from it. */
  config: SiteConfig;
  now?: () => number;
  genId?: () => string;
  /** Recorded as `author` on the revisions this call writes. */
  author?: string | null;
};

export type SiteState = {
  doc: SiteDoc;
  draftVersion: number;
  liveRevId: string | null;
  /** What the public site shows: the live revision, or the defaults when nothing is published. */
  liveDoc: SiteDoc;
  /** Publish would change the public site. */
  changes: string[];
};

export async function getSiteState(d: SiteDeps): Promise<SiteState> {
  const row = await d.repo.get();
  const doc = row?.draftDoc ?? defaultSiteDoc(d.config);
  const liveDoc =
    (row?.liveRevId
      ? (await d.repo.getRevision(row.liveRevId))?.docJson
      : undefined) ?? defaultSiteDoc(d.config);
  return {
    doc,
    draftVersion: row?.draftVersion ?? 0,
    liveRevId: row?.liveRevId ?? null,
    liveDoc,
    changes: siteChanges(liveDoc, doc),
  };
}

/**
 * Replaces the draft with `doc` (untrusted: validated here) if the draft is still `draftVersion`
 * (`STALE_DRAFT` otherwise). Like page autosave, it first snapshots the draft as it was when there
 * is no revision yet or the latest is over 5 minutes old and differs, in the same write.
 *
 * `batchId` makes the save idempotent, as for pages (`applyDraftOps`): the editor resends a save
 * whose response it never got with the same id, version and doc. If that save was the last one
 * (nothing saved since), the stored draft is returned instead of a spurious `STALE_DRAFT`.
 */
export async function saveSiteDraft(
  d: SiteDeps,
  draftVersion: number,
  input: unknown,
  batchId?: string
): Promise<{ draftVersion: number; doc: SiteDoc }> {
  const doc = validated(input);
  const row = await d.repo.get();
  const at = new Date(now(d));
  if (!row) {
    if (draftVersion !== 0) {
      throw staleDraft(0);
    }
    const snap = revision(
      d,
      "autosnapshot",
      defaultSiteDoc(d.config),
      null,
      at,
      "Site settings before the first edit"
    );
    const created = await d.repo.create(
      {
        id: SITE_ID,
        draftDoc: doc,
        draftVersion: 1,
        draftBaseRevId: snap.id,
        liveRevId: null,
        lastBatchId: batchId ?? null,
        updatedAt: at,
      },
      [snap]
    );
    if (!created) {
      throw staleDraft();
    }
    return { draftVersion: 1, doc };
  }
  if (row.draftVersion !== draftVersion) {
    if (
      batchId &&
      row.lastBatchId === batchId &&
      row.draftVersion === draftVersion + 1
    ) {
      return { draftVersion: row.draftVersion, doc: row.draftDoc };
    }
    throw staleDraft(row.draftVersion);
  }
  const before = row.draftDoc;
  const latest = await d.repo.latestRevision();
  let snap: SiteRevisionRow | null = null;
  if (
    !latest ||
    (at.getTime() - latest.createdAt.getTime() > AUTOSNAPSHOT_AFTER_MS &&
      !deepEqual(latest.docJson, before))
  ) {
    snap = revision(
      d,
      "autosnapshot",
      before,
      row.draftBaseRevId,
      at,
      summarizeSiteChange(latest?.docJson ?? defaultSiteDoc(d.config), before)
    );
  }
  const committed = await d.repo.commit(snap ? [snap] : [], {
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
  return { draftVersion: draftVersion + 1, doc };
}

/**
 * "Save version…": a `named` revision of the saved draft, which must still be `draftVersion` (the
 * editor saves pending edits first). Before the first edit there is nothing to name: the site
 * shows its built-in defaults, which the first save records anyway.
 */
export async function saveSiteVersion(
  d: SiteDeps,
  label: string,
  draftVersion: number
): Promise<{ revId: string }> {
  const row = await d.repo.get();
  if (!row) {
    throw new CmsError(
      "NOT_FOUND",
      "The site settings haven't been edited yet: there's nothing to name besides the built-in defaults"
    );
  }
  if (row.draftVersion !== draftVersion) {
    throw staleDraft(row.draftVersion);
  }
  const doc = validated(row.draftDoc);
  const latest = await d.repo.latestRevision();
  const rev = revision(
    d,
    "named",
    doc,
    row.draftBaseRevId,
    new Date(now(d)),
    summarizeSiteChange(latest?.docJson ?? defaultSiteDoc(d.config), doc),
    label
  );
  const committed = await d.repo.commit([rev], {
    draftBaseRevId: rev.id,
    ifDraftVersion: draftVersion,
  });
  if (!committed) {
    throw staleDraft();
  }
  return { revId: rev.id };
}

/**
 * An autosnapshot of the saved draft before a destructive edit (removing a footer column or a nav
 * item with dropdown links), unless the latest revision already is that draft. The draft must
 * still be `draftVersion`. Nothing to keep before the first edit (the defaults get recorded then).
 */
export async function snapshotSite(
  d: SiteDeps,
  draftVersion: number,
  reason: string
): Promise<{ revId: string | null }> {
  const row = await d.repo.get();
  if (!row) {
    if (draftVersion !== 0) {
      throw staleDraft(0);
    }
    return { revId: null };
  }
  if (row.draftVersion !== draftVersion) {
    throw staleDraft(row.draftVersion);
  }
  const latest = await d.repo.latestRevision();
  if (latest && deepEqual(latest.docJson, row.draftDoc)) {
    return { revId: null };
  }
  const summary = `${reason} · ${summarizeSiteChange(latest?.docJson ?? defaultSiteDoc(d.config), row.draftDoc)}`;
  const snap = revision(
    d,
    "autosnapshot",
    row.draftDoc,
    row.draftBaseRevId,
    new Date(now(d)),
    summary
  );
  const committed = await d.repo.commit([snap], {
    draftBaseRevId: snap.id,
    ifDraftVersion: draftVersion,
  });
  if (!committed) {
    throw staleDraft();
  }
  return { revId: snap.id };
}

/** `live: false`: D1 committed but the KV write failed; `republishSite` retries it. */
export type SitePublishResult = {
  ok: true;
  live: boolean;
  revId: string;
  summary: string;
};

/** Publishes the draft the client last saw: a `published` revision + live pointer, then KV `site`. */
export async function publishSite(
  d: SiteDeps,
  draftVersion: number
): Promise<SitePublishResult> {
  const row = await d.repo.get();
  if (!row) {
    throw new CmsError(
      "NOT_FOUND",
      "The site settings haven't been edited yet: the site already shows its defaults"
    );
  }
  if (row.draftVersion !== draftVersion) {
    throw staleDraft(row.draftVersion);
  }
  const doc = validated(row.draftDoc);
  const liveDoc = row.liveRevId
    ? (await d.repo.getRevision(row.liveRevId))?.docJson
    : undefined;
  const at = new Date(now(d));
  const summary = summarizeSiteChange(liveDoc ?? defaultSiteDoc(d.config), doc);
  const rev = revision(d, "published", doc, row.draftBaseRevId, at, summary);
  const committed = await d.repo.commit([rev], {
    liveRevId: rev.id,
    draftBaseRevId: rev.id,
    updatedAt: at,
    ifDraftVersion: draftVersion,
  });
  if (!committed) {
    throw staleDraft();
  }
  return { ok: true, live: await syncLive(d, rev), revId: rev.id, summary };
}

/** Rewrites KV `site` from the live revision (the Retry after `live: false`). */
export async function republishSite(d: SiteDeps): Promise<SitePublishResult> {
  const row = await d.repo.get();
  const rev = row?.liveRevId ? await d.repo.getRevision(row.liveRevId) : null;
  if (!rev) {
    throw new CmsError(
      "NOT_PUBLISHED",
      "The site settings have never been published"
    );
  }
  return {
    ok: true,
    live: await syncLive(d, rev),
    revId: rev.id,
    summary: rev.summary ?? "",
  };
}

export async function siteHistory(
  d: SiteDeps,
  opts: { limit: number; offset: number }
): Promise<{
  revisions: SiteRevisionMeta[];
  liveRevId: string | null;
  hasMore: boolean;
}> {
  const row = await d.repo.get();
  const rows = await d.repo.listRevisions({
    limit: opts.limit + 1,
    offset: opts.offset,
  });
  return {
    revisions: rows.slice(0, opts.limit),
    liveRevId: row?.liveRevId ?? null,
    hasMore: rows.length > opts.limit,
  };
}

export async function getSiteRevision(
  d: SiteDeps,
  revId: string
): Promise<SiteRevisionRow> {
  const rev = await d.repo.getRevision(revId);
  if (!rev) {
    throw new CmsError("NOT_FOUND", `site revision ${revId} not found`);
  }
  return rev;
}

/**
 * Makes an old revision the draft by appending a `restore` revision; nothing is removed. The
 * current draft is snapshotted first when the latest revision isn't it (same write). Publish to
 * make the restored settings live.
 */
export async function restoreSite(
  d: SiteDeps,
  revId: string,
  draftVersion: number
): Promise<{ revId: string; draftVersion: number; doc: SiteDoc }> {
  const row = await d.repo.get();
  if (!row) {
    throw new CmsError("NOT_FOUND", "There is no site history yet");
  }
  if (row.draftVersion !== draftVersion) {
    throw staleDraft(row.draftVersion);
  }
  const source = await getSiteRevision(d, revId);
  const doc = validated(source.docJson);
  const at = new Date(now(d));
  const latest = await d.repo.latestRevision();
  const revs: SiteRevisionRow[] = [];
  let parent = row.draftBaseRevId;
  if (!(latest && deepEqual(latest.docJson, row.draftDoc))) {
    const snap = revision(
      d,
      "autosnapshot",
      row.draftDoc,
      parent,
      at,
      summarizeSiteChange(
        latest?.docJson ?? defaultSiteDoc(d.config),
        row.draftDoc
      )
    );
    revs.push(snap);
    parent = snap.id;
  }
  const name = source.label
    ? `"${source.label}"`
    : `version from ${source.createdAt.toISOString()}`;
  const restored = revision(
    d,
    "restore",
    doc,
    parent,
    at,
    `Restored ${name} · ${summarizeSiteChange(row.draftDoc, doc)}`
  );
  revs.push(restored);
  const committed = await d.repo.commit(revs, {
    draftDoc: doc,
    draftBaseRevId: restored.id,
    bumpDraftVersion: true,
    ifDraftVersion: draftVersion,
    updatedAt: at,
  });
  if (!committed) {
    throw staleDraft();
  }
  return { revId: restored.id, draftVersion: draftVersion + 1, doc };
}

// ---------------------------------------------------------------------------------------------

async function syncLive(d: SiteDeps, rev: SiteRevisionRow): Promise<boolean> {
  try {
    const value: LiveSite = {
      revId: rev.id,
      publishedAt: rev.createdAt.toISOString(),
      doc: rev.docJson,
    };
    await d.kv.put(SITE_KV_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const now = (d: SiteDeps) => (d.now ?? Date.now)();

function revision(
  d: SiteDeps,
  kind: SiteRevisionRow["kind"],
  doc: SiteDoc,
  parentRevId: string | null,
  at: Date,
  summary: string,
  label: string | null = null
): SiteRevisionRow {
  return {
    id: (d.genId ?? (() => nanoid()))(),
    parentRevId,
    docJson: doc,
    kind,
    label,
    summary,
    author: d.author ?? null,
    createdAt: at,
  };
}

function validated(doc: unknown): SiteDoc {
  const result = validateSiteDoc(doc);
  if (!result.ok) {
    throw new CmsError(
      "INVALID_DOC",
      "site settings failed validation",
      result.errors
    );
  }
  return result.doc;
}

const staleDraft = (current?: number) =>
  new CmsError(
    "STALE_DRAFT",
    "the site settings changed since they were loaded; reload them",
    { current }
  );

/** The site service with its ports bound: build it once from `{ repo, kv, config, ... }`. */
export const createSiteService = (deps: SiteDeps) =>
  bindDeps(deps, {
    getSiteState,
    saveSiteDraft,
    saveSiteVersion,
    snapshotSite,
    publishSite,
    republishSite,
    siteHistory,
    getSiteRevision,
    restoreSite,
  });
