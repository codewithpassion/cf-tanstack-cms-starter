// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; constructor parameter properties as in the source.
import type { AgentProviderId } from "./models";
import type { PlanAction, PlanItemInput } from "./plan";

/**
 * Site-wide runs: the state machine of a run and its items.
 * The client drives a run one item per request; each item is a normal agent turn on that page.
 * Closing the tab pauses (an interrupted item goes back to `pending`), reopening resumes at the
 * next pending item. Review decisions settle items as accepted or rejected. Pure and client-safe:
 * the agent route, the server functions and the AI tab all use it.
 */

export type RunStatus =
  | "proposed"
  | "superseded"
  | "discarded"
  | "active"
  | "done"
  | "cancelled";

export type RunItemStatus =
  | "pending"
  | "running"
  | "proposed"
  | "accepted"
  | "rejected"
  | "skipped"
  | "failed";

export type RunItem = {
  id: string;
  slug: string;
  action: PlanAction;
  intent: string;
  from?: string;
  status: RunItemStatus;
  /** The page the item works on: the existing page, or the draft it created. */
  pageId?: string;
  /** A draft this item created (create/duplicate): archived by "Revert this run". */
  createdPageId?: string;
  /** Changesets the item staged (the latest pending one is what the queue shows). */
  changesetIds: string[];
  /** `agent` revisions its accepted changes became. */
  revisionIds: string[];
  /** Why it failed or was skipped, or what an interrupted attempt left behind. */
  note?: string;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  costUsd: number;
};

export type Run = {
  id: string;
  threadId: string;
  status: RunStatus;
  summary: string;
  items: RunItem[];
  costUsd: number;
  provider: AgentProviderId;
  model: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  /** Compare-and-set counter for concurrent writers (the running turn and the review queue). */
  version: number;
};

export class RunError extends Error {
  constructor(
    readonly code: "NOT_ALLOWED" | "NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

/** Run ids carry a prefix so History can tell a run's `agent_run_id` from a single-page conversation's. */
export const RUN_ID_PREFIX = "run_";
export const isRunId = (id: string | null | undefined): id is string =>
  !!id && id.startsWith(RUN_ID_PREFIX);

/**
 * Each item runs in its own transcript: a thread with this id, scope
 * `item`, so the site thread keeps only planning and the item turns don't pile up in one
 * transcript. `n` is the item's 1-based position (items never move once approved), which keeps the
 * id short enough for the thread-id checks (at most 64 characters).
 */
export const itemThreadId = (runId: string, n: number) => `${runId}~${n}`;

/** The run and item position of an item thread, or null for any other thread. */
export function parseItemThread(
  threadId: string
): { runId: string; n: number } | null {
  const at = threadId.lastIndexOf("~");
  if (at < 0 || !isRunId(threadId.slice(0, at))) {
    return null;
  }
  const n = Number(threadId.slice(at + 1));
  return Number.isInteger(n) && n > 0
    ? { runId: threadId.slice(0, at), n }
    : null;
}

/** The transcript thread of an item of `run`. */
export function threadOfItem(run: Run, itemId: string): string {
  const n = run.items.findIndex((i) => i.id === itemId) + 1;
  if (!n) {
    throw new RunError("NOT_FOUND", "That item isn't in this run.");
  }
  return itemThreadId(run.id, n);
}

export function newRunItems(
  plan: readonly PlanItemInput[],
  genId: () => string
): RunItem[] {
  return plan.map((p) => ({
    id: genId(),
    slug: p.slug,
    action: p.action,
    intent: p.intent,
    ...(p.from !== undefined && { from: p.from }),
    status: "pending",
    changesetIds: [],
    revisionIds: [],
    attempts: 0,
    costUsd: 0,
  }));
}

const DONE: ReadonlySet<RunItemStatus> = new Set([
  "proposed",
  "accepted",
  "rejected",
  "skipped",
  "failed",
]);
export const isItemFinished = (item: RunItem) => DONE.has(item.status);

function requireItem(run: Run, itemId: string): RunItem {
  const item = run.items.find((i) => i.id === itemId);
  if (!item) {
    throw new RunError("NOT_FOUND", "That item isn't in this run.");
  }
  return item;
}

const withItem = (
  run: Run,
  itemId: string,
  patch: (item: RunItem) => RunItem
): Run => ({
  ...run,
  items: run.items.map((i) => (i.id === itemId ? patch(i) : i)),
});

/** An active run whose items have all finished is done; a done run with work again is active. */
function settle(run: Run): Run {
  if (run.status !== "active" && run.status !== "done") {
    return run;
  }
  const open = run.items.some((i) => !isItemFinished(i));
  return { ...run, status: open ? "active" : "done" };
}

/** The user approves the (edited, validated) plan: the run becomes active with every item pending. */
export function approveRun(run: Run, items: RunItem[], now: Date): Run {
  if (run.status !== "proposed") {
    throw new RunError(
      "NOT_ALLOWED",
      `This plan is ${run.status}; only a proposed plan can be approved.`
    );
  }
  return { ...run, status: "active", items, approvedAt: now.toISOString() };
}

export function discardRun(run: Run): Run {
  if (run.status !== "proposed") {
    throw new RunError("NOT_ALLOWED", `This plan is ${run.status}.`);
  }
  return { ...run, status: "discarded" };
}

/**
 * The item to run next: the first pending one, or one left `running` by a request that died
 * (the thread's turn lock is free, so no turn is working on it). Null when the run isn't active
 * or nothing is left.
 */
export function nextItem(
  run: Run,
  opts: { threadBusy: boolean }
): RunItem | null {
  if (run.status !== "active") {
    return null;
  }
  return (
    run.items.find(
      (i) =>
        i.status === "pending" || (i.status === "running" && !opts.threadBusy)
    ) ?? null
  );
}

/** The item's turn starts (the caller holds the thread's turn lock). */
export function startItem(run: Run, itemId: string, now: Date): Run {
  if (run.status !== "active") {
    throw new RunError(
      "NOT_ALLOWED",
      run.status === "done"
        ? "This run has finished."
        : `This run is ${run.status}.`
    );
  }
  const item = requireItem(run, itemId);
  if (item.status !== "pending" && item.status !== "running") {
    throw new RunError(
      "NOT_ALLOWED",
      `/${item.slug} is already ${item.status}.`
    );
  }
  return withItem(run, itemId, (i) => ({
    ...i,
    status: "running",
    attempts: i.attempts + 1,
    startedAt: now.toISOString(),
  }));
}

/** How an item's turn ended. `stopReason` as the agent loop reports it. */
export type ItemOutcome = {
  stopReason: string | null;
  /** Changesets staged during this turn for the item's page. */
  changesetIds: string[];
  /** The draft created during this turn (create/duplicate). */
  createdPageId?: string;
  /** The item's page, once known. */
  pageId?: string;
  costUsd: number;
  error?: string;
};

/** Ended early (Stop, closed tab, a spending cap): the item runs again on resume. */
const INTERRUPTED = new Set(["aborted", "stopped", "detached", "budget"]);
/** Ended without a usable answer. */
const FAILED = new Set(["error", "refusal", "max_tokens"]);

/** A run that takes no more work: cancelled, or reverted. What an item still running stages then is discarded. */
export const runClosed = (run: Run) =>
  !!run.revertedAt || (run.status !== "active" && run.status !== "done");

/**
 * Records the end of an item's turn. Interrupted → `pending` again (what it already created is
 * kept on the item, so the next attempt continues instead of starting over). Otherwise anything
 * staged or created → `proposed` (it waits in the review queue), also when the turn then failed;
 * an answer with nothing staged → `skipped`; an error, refusal or cut-off reply with nothing
 * staged → `failed`. On a run cancelled or reverted meanwhile the item ends `skipped`: the caller
 * rejects what it staged and archives the draft it created (`endItem`).
 */
export function finishItem(
  run: Run,
  itemId: string,
  out: ItemOutcome,
  now: Date
): Run {
  const item = requireItem(run, itemId);
  const changesetIds = [
    ...new Set([...item.changesetIds, ...out.changesetIds]),
  ];
  const createdPageId = item.createdPageId ?? out.createdPageId;
  const pageId = out.pageId ?? item.pageId ?? createdPageId;
  const produced = changesetIds.length > 0 || !!createdPageId;
  const reason = out.stopReason ?? "";
  let status: RunItemStatus;
  let note: string | undefined;
  if (runClosed(run)) {
    status = "skipped";
    note = `The run was ${run.revertedAt ? "reverted" : "cancelled"} while this page was running${produced ? "; what it staged was rejected" : ""}.`;
  } else if (INTERRUPTED.has(reason)) {
    status = "pending";
    note = createdPageId
      ? "Interrupted after creating the draft; the next attempt continues on it."
      : "Interrupted; it runs again when the run resumes.";
  } else if (produced) {
    status = "proposed";
    if (FAILED.has(reason)) {
      note = `${out.error ?? failedNote(reason)} What it staged before that is in the review queue.`;
    }
  } else if (FAILED.has(reason)) {
    status = "failed";
    note = out.error ?? failedNote(reason);
  } else {
    status = "skipped";
    note = "The agent proposed no changes for this page.";
  }
  const next = withItem(run, itemId, (i) => ({
    ...i,
    status,
    changesetIds,
    ...(createdPageId && { createdPageId }),
    ...(pageId && { pageId }),
    ...(note ? { note } : { note: undefined }),
    costUsd: round6(i.costUsd + out.costUsd),
    ...(status !== "pending" && { finishedAt: now.toISOString() }),
  }));
  return settle({ ...next, costUsd: round6(run.costUsd + out.costUsd) });
}

const failedNote = (reason: string) =>
  reason === "refusal"
    ? "The model declined this item."
    : reason === "max_tokens"
      ? "The reply hit the output limit."
      : "The turn failed.";

/**
 * A tool of the item's running turn staged a changeset or created its draft: recorded on the run
 * at once, so it survives a turn that then throws or a Worker that dies before `finishItem`.
 */
export function recordProduced(
  run: Run,
  itemId: string,
  p: { changesetId?: string; createdPageId?: string }
): Run {
  return withItem(run, itemId, (i) => ({
    ...i,
    ...(p.changesetId &&
      !i.changesetIds.includes(p.changesetId) && {
        changesetIds: [...i.changesetIds, p.changesetId],
      }),
    ...(p.createdPageId && {
      createdPageId: i.createdPageId ?? p.createdPageId,
      pageId: i.pageId ?? p.createdPageId,
    }),
  }));
}

/** The user skips an item that hasn't produced anything (or failed). */
export function skipItem(run: Run, itemId: string): Run {
  const item = requireItem(run, itemId);
  if (item.status !== "pending" && item.status !== "failed") {
    throw new RunError(
      "NOT_ALLOWED",
      `/${item.slug} is ${item.status}; only pending or failed items can be skipped.`
    );
  }
  return settle(
    withItem(run, itemId, (i) => ({
      ...i,
      status: "skipped",
      note: "Skipped by you.",
    }))
  );
}

/** Runs a failed or skipped item again. */
export function retryItem(run: Run, itemId: string): Run {
  if (run.status !== "active" && run.status !== "done") {
    throw new RunError("NOT_ALLOWED", `This run is ${run.status}.`);
  }
  if (run.revertedAt) {
    throw new RunError("NOT_ALLOWED", "This run was reverted.");
  }
  const item = requireItem(run, itemId);
  if (item.status !== "failed" && item.status !== "skipped") {
    throw new RunError("NOT_ALLOWED", `/${item.slug} is ${item.status}.`);
  }
  return settle(
    withItem(run, itemId, (i) => ({ ...i, status: "pending", note: undefined }))
  );
}

/** Stops the run for good: items not started are skipped. Proposals already staged stay reviewable. */
export function cancelRun(run: Run): Run {
  if (run.status !== "active") {
    throw new RunError("NOT_ALLOWED", `This run is ${run.status}.`);
  }
  return {
    ...run,
    status: "cancelled",
    items: run.items.map((i) =>
      i.status === "pending" || i.status === "running"
        ? { ...i, status: "skipped" as const, note: "The run was cancelled." }
        : i
    ),
  };
}

/** The item that staged `changesetId`. */
export const itemOfChangeset = (run: Run, changesetId: string) =>
  run.items.find((i) => i.changesetIds.includes(changesetId)) ?? null;

/**
 * A review decision on one of the item's changesets (or, `changesetId` null, on its created draft
 * alone). `statuses`: every changeset of the item after the decision. A proposed item settles as
 * accepted once nothing of it is pending and something was kept, else as rejected.
 */
export function decideItem(
  run: Run,
  itemId: string,
  d: {
    revId?: string | null;
    statuses: Record<string, string>;
    draft?: "kept" | "archived";
  }
): Run {
  const item = requireItem(run, itemId);
  if (
    item.status !== "proposed" &&
    item.status !== "accepted" &&
    item.status !== "rejected"
  ) {
    throw new RunError(
      "NOT_ALLOWED",
      `/${item.slug} is ${item.status}; there is nothing to review yet.`
    );
  }
  const revisionIds = d.revId
    ? [...item.revisionIds, d.revId]
    : item.revisionIds;
  const statuses = item.changesetIds
    .map((id) => d.statuses[id])
    .filter((s): s is string => !!s && s !== "superseded");
  let status: RunItemStatus;
  if (statuses.includes("pending")) {
    status = "proposed";
  } else if (d.draft === "archived") {
    status = "rejected";
  } else if (statuses.some((s) => s === "accepted" || s === "partial")) {
    status = "accepted";
  }
  // A draft created with its content in full (no changeset): keeping it is the accept.
  else if (!statuses.length && item.createdPageId) {
    status = d.draft === "kept" ? "accepted" : "proposed";
  } else {
    status = "rejected";
  }
  return withItem(run, itemId, (i) => ({ ...i, revisionIds, status }));
}

export function runCounts(run: Run): Record<RunItemStatus, number> {
  const counts: Record<RunItemStatus, number> = {
    pending: 0,
    running: 0,
    proposed: 0,
    accepted: 0,
    rejected: 0,
    skipped: 0,
    failed: 0,
  };
  for (const i of run.items) {
    counts[i.status]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Revert this run (computed by server/runs.ts `revertPlan`, shown by the review queue)

type PageInfo = { pageId: string; slug: string; title: string };

export type RevertAction =
  /**
   * Restore to the revision before the run's first change on the page. `laterEdits`: someone else
   * changed the page after the run's first change (a revision not from this run, or a draft that
   * isn't the run's last change); restoring replaces those edits (they stay in History), so the
   * dialog leaves such pages out unless ticked. `live`: the published page carries the run's
   * changes (published after the run's first change); a restore changes the draft only.
   */
  | (PageInfo & {
      kind: "restore";
      targetRevId: string;
      laterEdits: boolean;
      live: boolean;
    })
  /** A draft the run created: archived. `laterEdits`: it was edited since the run created or last changed it. */
  | (PageInfo & { kind: "archive"; laterEdits: boolean })
  /** Nothing to do, and why. */
  | (PageInfo & { kind: "skip"; reason: string });

/** Whether `action` is done by default (the dialog's initial tick): not when someone edited the page after the run. */
export const revertsByDefault = (a: RevertAction) =>
  a.kind !== "skip" && !a.laterEdits;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
