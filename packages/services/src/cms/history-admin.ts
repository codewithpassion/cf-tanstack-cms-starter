import { deepEqual } from "@repo/cms-core/ops/json";
import { slugToPath } from "@repo/cms-core/paths";

import { adminResult } from "./admin-errors";
import type {
  AdminResult,
  DraftReplaced,
  EditorPageWire,
  RestoreRevisionResult,
  RevisionList,
  RevisionListItem,
  RollbackLiveResult,
} from "./admin-result";
import { bindDeps } from "./bind";
// biome-ignore lint/performance/noNamespaceImport: server-only; `service.x` / `history.x` keep the call sites readable, as in the source.
import * as service from "./pages-service";
import type { RevisionListRow } from "./repo";

/**
 * The history panel's service bodies (docs/cms-plan.md §3.2). The tRPC `adminProcedure` has already
 * checked the admin and parsed the payload; expected failures come back as `{ ok: false, code }` (admin-errors.ts).
 * `d.author` should be the admin's user id: it is recorded on the revisions written here.
 */

const CURSOR_RE = /^\d{1,9}$/;

export const HISTORY_PAGE_SIZE = 50;
export const MAX_VERSION_LABEL = 80;

export function listHistory(
  d: service.ServiceDeps,
  input: { pageId: string; cursor?: string }
): Promise<AdminResult<RevisionList>> {
  return adminResult(async () => {
    const offset = parseCursor(input.cursor);
    const { page, revisions, pinned, hasMore } = await service.revisionHistory(
      d,
      input.pageId,
      {
        limit: HISTORY_PAGE_SIZE,
        offset,
      }
    );
    const item = (r: RevisionListRow) =>
      listItem(r, page.liveRevId, d.author ?? null);
    return {
      revisions: revisions.map(item),
      pinned: pinned.map(item),
      nextCursor: hasMore ? String(offset + revisions.length) : null,
    };
  });
}

export function revisionDoc(
  d: service.ServiceDeps,
  input: { pageId: string; revId: string }
): Promise<AdminResult<{ docJson: string }>> {
  return adminResult(async () => {
    const rev = await service.pageRevision(d, input.pageId, input.revId);
    return { docJson: JSON.stringify(rev.docJson) };
  });
}

/** A named version of the saved draft; `draftVersion`, when given, must still be the draft. */
export function saveNamedVersion(
  d: service.ServiceDeps,
  input: { pageId: string; label: string; draftVersion?: number }
): Promise<AdminResult<{ revId: string }>> {
  const label = versionLabel(input.label);
  return adminResult(async () => {
    const rev = await service.saveVersion(
      d,
      input.pageId,
      label,
      input.draftVersion
    );
    return { revId: rev.id };
  });
}

export function restoreRevision(
  d: service.ServiceDeps,
  input: { pageId: string; revId: string; draftVersion: number }
): Promise<AdminResult<RestoreRevisionResult>> {
  return adminResult(async () => {
    const { revId, dropped, seoReplaced } = await service.restore(
      d,
      input.pageId,
      input.revId,
      input.draftVersion
    );
    return {
      revId,
      dropped: dropped.map((b) => ({ key: b.key, label: d.labelFor(b.type) })),
      seoReplaced,
      editor: await editorPage(d, input.pageId),
    };
  });
}

export function restoreBlockFromRevision(
  d: service.ServiceDeps,
  input: {
    pageId: string;
    revId: string;
    blockKey: string;
    draftVersion: number;
  }
): Promise<AdminResult<DraftReplaced>> {
  return adminResult(async () => {
    await service.restoreBlock(
      d,
      input.pageId,
      input.revId,
      input.blockKey,
      input.draftVersion
    );
    return { editor: await editorPage(d, input.pageId) };
  });
}

export function rollbackLive(
  d: service.ServiceDeps,
  input: { pageId: string; revId: string }
): Promise<AdminResult<RollbackLiveResult>> {
  return adminResult(async () => {
    const { live, revId } = await service.rollbackLive(
      d,
      input.pageId,
      input.revId
    );
    const editor = await editorPage(d, input.pageId);
    return { live, revId, path: slugToPath(editor.page.slug), editor };
  });
}

/** Rename (`label`: "" clears the rename) and/or pin. */
export function labelRevision(
  d: service.ServiceDeps,
  input: { pageId: string; revId: string; label?: string; pinned?: boolean }
): Promise<AdminResult> {
  let label: string | null | undefined;
  if (input.label !== undefined) {
    label = input.label.trim() === "" ? null : versionLabel(input.label);
  }
  return adminResult(async () => {
    await service.labelRevision(d, input.pageId, input.revId, {
      ...(label !== undefined && { label }),
      ...(input.pinned !== undefined && { pinned: input.pinned }),
    });
    return {};
  });
}

/** The page as the editor loads it (same shape as getEditorPageFn). */
export async function editorPage(
  d: service.ServiceDeps,
  pageId: string
): Promise<EditorPageWire> {
  const page = await service.getPage(d, { id: pageId });
  if (!page?.draftDoc) {
    throw new service.CmsError("NOT_FOUND", `Page ${pageId} not found`);
  }
  const live = page.liveRevId
    ? await service.getRevision(d, page.liveRevId)
    : null;
  return {
    page: {
      id: page.id,
      kind: page.kind,
      slug: page.slug,
      title: page.title,
      status: page.status,
      updatedAt: page.updatedAt.toISOString(),
      liveRevId: page.liveRevId,
    },
    draftDocJson: JSON.stringify(page.draftDoc),
    draftVersion: page.draftVersion,
    hasUnpublishedChanges: live
      ? !deepEqual(live.docJson, page.draftDoc)
      : false,
  };
}

function listItem(
  r: RevisionListRow,
  liveRevId: string | null,
  userId: string | null
): RevisionListItem {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    summary: r.summary,
    author: r.author,
    byYou: userId !== null && r.author === userId,
    agentRunId: r.agentRunId,
    createdAt: r.createdAt.toISOString(),
    isLive: r.id === liveRevId,
    pinned: r.pinned,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!CURSOR_RE.test(cursor)) {
    throw new Error('Expected "cursor" to be a cursor from a previous page');
  }
  return Number(cursor);
}

function versionLabel(raw: string): string {
  const label = raw.trim();
  if (!label || label.length > MAX_VERSION_LABEL) {
    throw new Error(`A version name needs 1–${MAX_VERSION_LABEL} characters`);
  }
  return label;
}

/** The history admin with the page service's ports bound. */
export const createHistoryAdmin = (deps: service.ServiceDeps) =>
  bindDeps(deps, {
    listHistory,
    revisionDoc,
    saveNamedVersion,
    restoreRevision,
    restoreBlockFromRevision,
    rollbackLive,
    labelRevision,
    editorPage,
  });
