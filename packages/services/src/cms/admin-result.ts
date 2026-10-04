import type { OpErrorCode } from "@repo/cms-core/ops/apply-ops";
import type { PageDoc, PageKind } from "@repo/cms-core/types";

import type { CmsErrorCode } from "./pages-service";

/**
 * Result types of the admin server functions (admin-fns.ts). Types only, so editor code and route
 * loaders can import them without pulling the page service into the client bundle.
 */

/** `SIGNED_OUT` never comes from a service: the web client maps a tRPC UNAUTHORIZED to it (D8). */
export type AdminErrorCode = CmsErrorCode | OpErrorCode | "SIGNED_OUT";

/** A failure the editor can show: `path` points at the offending field or op, e.g. `blocks[2].props.heading`, `ops[0]`. */
export type AdminError = {
  ok: false;
  code: AdminErrorCode;
  message: string;
  path?: string;
};

export type AdminResult<T extends object = object> =
  | ({ ok: true } & T)
  | AdminError;

export type PageStatus = "draft" | "published" | "archived";

export type PageListItem = {
  id: string;
  kind: PageKind;
  slug: string;
  title: string;
  status: PageStatus;
  /** ISO timestamp. */
  updatedAt: string;
};

export type EditorPage = {
  page: PageListItem & { liveRevId: string | null };
  draftDoc: PageDoc;
  draftVersion: number;
  /** The draft differs from the live revision (always false for a page that isn't live). */
  hasUnpublishedChanges: boolean;
};

/**
 * Documents travel as JSON strings: `PageDoc` holds open JSON-LD records (`Record<string, unknown>`),
 * which the server-function serializer types reject, and a string is cheaper to (de)serialise anyway.
 */
export type EditorPageWire = Omit<EditorPage, "draftDoc"> & {
  draftDocJson: string;
};

export function editorPageFromWire({
  draftDocJson,
  ...rest
}: EditorPageWire): EditorPage {
  return { ...rest, draftDoc: JSON.parse(draftDocJson) as PageDoc };
}

/** The saved (server-normalised) draft is `docJson`. */
export type SaveDraftResult = { draftVersion: number; docJson: string };

/** `live: false`: D1 has the new revision but the KV write failed ("published, not live yet"). */
export type PublishPageResult = { live: boolean; revId: string; path: string };

// ---------------------------------------------------------------------------------------------
// History (docs/cms-plan.md §3.2)

export type RevisionKind =
  | "autosnapshot"
  | "named"
  | "published"
  | "agent"
  | "restore";

export type RevisionListItem = {
  id: string;
  kind: RevisionKind;
  /** Display label: a rename wins over the label it was saved with. */
  label: string | null;
  summary: string | null;
  /** Clerk user id of whoever wrote it (null for older revisions and agent runs). */
  author: string | null;
  /** Written by the admin asking. */
  byYou: boolean;
  agentRunId: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** The revision the public site serves now. */
  isLive: boolean;
  pinned: boolean;
};

/** `nextCursor`: pass back for older entries (null at the end). `pinned` comes with the first page only. */
export type RevisionList = {
  revisions: RevisionListItem[];
  pinned: RevisionListItem[];
  nextCursor: string | null;
};

/** After a restore or rollback: the page as the editor reloads it. */
export type DraftReplaced = { editor: EditorPageWire };

/**
 * After restoring a whole version: `dropped` lists the version's blocks left out because they no
 * longer pass validation (`label` is the block type's name), `seoReplaced` the SEO fields kept
 * from the draft for the same reason.
 */
export type RestoreRevisionResult = DraftReplaced & {
  revId: string;
  dropped: { key: string; label: string }[];
  seoReplaced: string[];
};

export type RollbackLiveResult = PublishPageResult & DraftReplaced;
