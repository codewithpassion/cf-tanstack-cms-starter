// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.

import {
  conflicts,
  groupsOf,
  opsToApply,
  seoOpFor,
} from "@repo/cms-core/agent/changeset";
import {
  decideItem,
  finishItem,
  itemOfChangeset,
  parseItemThread,
  type RevertAction,
  type Run,
  RunError,
  type RunItem,
  revertsByDefault,
  runClosed,
} from "@repo/cms-core/agent/run";
import type { SeoProposal } from "@repo/cms-core/agent/types";
import { applyOps } from "@repo/cms-core/ops/apply-ops";
import { deepEqual } from "@repo/cms-core/ops/json";
import type { Op, PageDoc } from "@repo/cms-core/types";
import {
  archivePage,
  CmsError,
  commitAgentChange,
  restore,
  type ServiceDeps,
} from "../cms/pages-service";
import type { PageRow, RevisionMeta } from "../cms/repo";
import { type AgentStore, type ChangesetRow, toChangeset } from "./store-port";

/**
 * Site-wide runs on the server (docs/cms-plan.md §3.2, §4.4, Phase 6): writing a run safely while
 * the running turn and the review queue both update it, the message that starts an item's turn,
 * accepting and rejecting a run's proposals (from the queue or the editor), and "Revert this run".
 * Takes its dependencies as arguments, so tests run it on the in-memory repo and store.
 */

const MAX_TRIES = 5;

/** Read, change, compare-and-set; retried when another writer saved in between. */
export async function mutateRun(
  store: Pick<AgentStore, "getRun" | "saveRun">,
  id: string,
  change: (run: Run) => Run,
  now = new Date()
): Promise<Run> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const run = await store.getRun(id);
    if (!run) {
      throw new RunError("NOT_FOUND", "Run not found.");
    }
    const next = {
      ...change(run),
      updatedAt: now.toISOString(),
      version: run.version,
    };
    if (await store.saveRun(next)) {
      return { ...next, version: run.version + 1 };
    }
  }
  throw new Error("The run kept changing while it was being saved; try again.");
}

/**
 * The run (and item) a changeset was staged for, if it came from one: from its item thread, or
 * (runs started before item threads) by looking through its site thread's runs.
 */
export async function runOfChangeset(
  store: Pick<AgentStore, "listRuns" | "getRun">,
  cs: Pick<ChangesetRow, "id" | "threadId">
): Promise<{ run: Run; item: RunItem } | null> {
  const owner = parseItemThread(cs.threadId);
  const runs = owner
    ? [await store.getRun(owner.runId)].filter((r): r is Run => !!r)
    : await store.listRuns({ threadId: cs.threadId });
  for (const run of runs) {
    const item = itemOfChangeset(run, cs.id);
    if (item) {
      return { run, item };
    }
  }
  return null;
}

/**
 * The user message that starts an item's turn: the approved intent (the user's edited plan), the
 * plan for context, and what an interrupted earlier attempt left behind.
 */
export function itemMessage(
  run: Run,
  item: RunItem,
  createdSlug: string | null
): string {
  const n = run.items.findIndex((i) => i.id === item.id) + 1;
  const what =
    item.action === "duplicate"
      ? `duplicate /${item.from} as /${item.slug}`
      : `${item.action} /${item.slug}`;
  const others = run.items
    .filter((i) => i.id !== item.id)
    .map(
      (i) =>
        `- ${i.action} /${i.slug} (${i.status}): ${i.intent.replace(/\s+/g, " ").slice(0, 160)}`
    );
  return [
    `[Run item ${n} of ${run.items.length}: ${what}]`,
    item.intent,
    "",
    `The approved plan: ${run.summary}`,
    ...(others.length
      ? [
          "Other items (for context only; each runs in its own turn):",
          ...others,
        ]
      : []),
    ...(item.attempts > 1
      ? [
          "",
          `An earlier attempt at this item was interrupted.${createdSlug ? ` It already created the draft /${createdSlug}: don't create it again, change it with propose_ops.` : ""}`,
        ]
      : []),
  ].join("\n");
}

/**
 * Records the end of an item's turn on the run (see `finishItem`): what the turn staged and
 * created, and its spend (the item thread's cost now minus `costBefore`, which also counts stopped
 * and failed calls). When the run was cancelled or reverted while the item ran, what the turn
 * staged is rejected and the draft it created is archived (while still an unpublished draft).
 */
export async function endItem(
  r: { store: AgentStore; cms: ServiceDeps },
  input: {
    runId: string;
    itemId: string;
    threadId: string;
    costBefore: number;
    stopReason: string | null;
    produced: { changesetIds: string[]; createdPageIds: string[] };
    pageId: string | null;
    error?: string;
  },
  now = new Date()
): Promise<Run> {
  const spent = Math.max(
    0,
    (await r.store.threadCost(input.threadId)) - input.costBefore
  );
  let discarded = false;
  const run = await mutateRun(
    r.store,
    input.runId,
    (x) => {
      discarded = runClosed(x);
      return finishItem(
        x,
        input.itemId,
        {
          stopReason: input.stopReason,
          changesetIds: input.produced.changesetIds,
          ...(input.produced.createdPageIds[0] && {
            createdPageId: input.produced.createdPageIds[0],
          }),
          ...(input.pageId && { pageId: input.pageId }),
          costUsd: spent,
          ...(input.error && { error: input.error }),
        },
        now
      );
    },
    now
  );
  if (discarded) {
    const item = run.items.find((i) => i.id === input.itemId)!;
    await rejectPending(r.store, item.changesetIds, now);
    if (item.createdPageId) {
      const page = await r.cms.repo.findPage({ id: item.createdPageId });
      if (page?.status === "draft") {
        await archivePage(r.cms, page.id);
      }
    }
  }
  return run;
}

async function rejectPending(store: AgentStore, ids: string[], at: Date) {
  if (!ids.length) {
    return;
  }
  for (const cs of (await store.changesetsByIds(ids)).filter(
    (c) => c.status === "pending"
  )) {
    await store.decide(
      cs.id,
      "rejected",
      {
        accepted: [],
        rejected:
          cs.kind === "ops"
            ? groupsOf((cs.payload as { ops: Op[] }).ops)
            : ["seo"],
      },
      at
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Review

export type ReviewDeps = {
  cms: ServiceDeps;
  store: AgentStore;
  now?: () => Date;
};

const nowOf = (r: ReviewDeps) => r.now?.() ?? new Date();

/** Statuses of every changeset of the item, after a decision. */
async function itemStatuses(
  store: AgentStore,
  item: RunItem
): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await store.changesetsByIds(item.changesetIds)).map((c) => [
      c.id,
      c.status,
    ])
  );
}

async function pendingRunChangeset(r: ReviewDeps, changesetId: string) {
  const cs = await r.store.getChangeset(changesetId);
  if (!cs) {
    throw new CmsError("NOT_FOUND", "Proposal not found.");
  }
  if (cs.status !== "pending") {
    throw new CmsError(
      "LIVE_CHANGED",
      `This proposal was already ${cs.status}.`
    );
  }
  const owner = await runOfChangeset(r.store, cs);
  if (!owner) {
    throw new CmsError(
      "NOT_FOUND",
      "This proposal isn't part of a site-wide run."
    );
  }
  if (owner.run.revertedAt) {
    throw new CmsError("LIVE_CHANGED", "This run was reverted.");
  }
  return { cs, ...owner };
}

type AcceptInput = {
  changesetId: string;
  groups?: string[];
  variant?: number;
  draftVersion?: number;
  confirmConflicts?: string[];
};

/**
 * What accepting `cs` writes on its page now: `ops` changesets with the chosen groups (all by
 * default), `seo` changesets with the chosen title/description variant (required). Refuses when
 * the page changed in the proposal's chosen blocks since it was staged: without `draftVersion` (the
 * review queue, MCP) always (those need a look in the editor); with it (the draft the caller
 * computed conflicts on) unless the caller kept those blocks knowingly (`confirmConflicts`), and
 * `STALE_DRAFT` when the draft moved since.
 */
async function acceptance(r: ReviewDeps, cs: ChangesetRow, input: AcceptInput) {
  const page = await r.cms.repo.findPage({ id: cs.pageId });
  if (!page?.draftDoc) {
    throw new CmsError("NOT_FOUND", "The page is gone.");
  }
  if (page.status === "archived") {
    throw new CmsError("ARCHIVED", `/${page.slug} is archived.`);
  }
  if (
    input.draftVersion !== undefined &&
    input.draftVersion !== page.draftVersion
  ) {
    throw new CmsError(
      "STALE_DRAFT",
      "The page changed since you looked at this proposal; review it again.",
      { current: page.draftVersion }
    );
  }
  const current = page.draftDoc;
  let ops: Op[];
  let accepted: string[];
  let rejected: string[] = [];
  let variant: number | undefined;
  if (cs.kind === "ops") {
    const staged = (cs.payload as { ops: Op[] }).ops;
    const all = groupsOf(staged);
    const chosen = new Set(input.groups ?? all);
    const confirmed = new Set(
      input.draftVersion === undefined ? [] : (input.confirmConflicts ?? [])
    );
    const changed = conflicts(cs.baseDoc, current, staged).filter(
      (c) => chosen.has(c.group) && !confirmed.has(c.group)
    );
    if (changed.length) {
      throw new CmsError(
        "LIVE_CHANGED",
        input.draftVersion === undefined
          ? `/${page.slug} changed since this proposal was made (${changed.length} block(s)). Review it in the editor.`
          : `You changed ${changed.length} of the chosen block(s) since this proposal was made. Look at the proposal again.`,
        { conflicts: changed }
      );
    }
    let proposed: PageDoc = current;
    try {
      proposed = applyOps(cs.baseDoc, staged).doc;
    } catch {
      // Anchors fall back to the current page.
    }
    const res = opsToApply(current, staged, chosen, proposed);
    if (!res.ops.length) {
      throw new CmsError(
        "INVALID_OPS",
        "Nothing to apply: the blocks this proposal changes are gone."
      );
    }
    ops = res.ops;
    accepted = [...chosen].filter(
      (g) => !res.skipped.includes(g) && all.includes(g)
    );
    rejected = all.filter((g) => !accepted.includes(g));
  } else {
    const proposal = cs.payload as SeoProposal;
    if (input.variant === undefined) {
      throw new CmsError(
        "INVALID_OPS",
        "Choose which title and description to use."
      );
    }
    variant = input.variant;
    if (!proposal.variants[variant]) {
      throw new CmsError("INVALID_OPS", "That title option doesn't exist.");
    }
    ops = [seoOpFor(proposal, proposal.variants[variant])];
    accepted = ["seo"];
  }
  const status: "accepted" | "partial" = rejected.length
    ? "partial"
    : "accepted";
  return {
    page,
    ops,
    decide: {
      id: cs.id,
      status,
      decision: {
        accepted,
        rejected,
        ...(variant !== undefined && { variant }),
      },
    },
  };
}

/**
 * Accepts a run's proposal in one commit (`commitAgentChange`), with the proposal's decision in
 * the same commit (see `acceptance` for what is applied and when it is refused). Records the
 * decision on the run item.
 */
export async function acceptRunChangeset(
  r: ReviewDeps,
  input: AcceptInput
): Promise<{ revId: string; draftVersion: number; run: Run }> {
  const { cs, run, item } = await pendingRunChangeset(r, input.changesetId);
  const { page, ops, decide } = await acceptance(r, cs, input);
  const committed = await commitAgentChange(
    r.cms,
    page.id,
    page.draftVersion,
    ops,
    { summary: cs.summary, agentRunId: run.id, decide }
  );
  const statuses = await itemStatuses(r.store, item);
  const next = await mutateRun(
    r.store,
    run.id,
    (x) => decideItem(x, item.id, { revId: committed.revId, statuses }),
    nowOf(r)
  );
  return {
    revId: committed.revId,
    draftVersion: committed.draftVersion,
    run: next,
  };
}

/**
 * Accepts a page conversation's proposal on the server (the editor applies those in the browser):
 * the same rules as a run's (`acceptance`), one commit with the decision, an `agent` revision
 * tagged with the conversation (as the editor's accept does). Used by the MCP server.
 */
export async function acceptConversationChangeset(
  r: ReviewDeps,
  input: AcceptInput
): Promise<{ revId: string; draftVersion: number }> {
  const cs = await r.store.getChangeset(input.changesetId);
  if (!cs) {
    throw new CmsError("NOT_FOUND", "Proposal not found.");
  }
  if (cs.status !== "pending") {
    throw new CmsError(
      "LIVE_CHANGED",
      `This proposal was already ${cs.status}.`
    );
  }
  if (await runOfChangeset(r.store, cs)) {
    throw new CmsError(
      "LIVE_CHANGED",
      "This proposal belongs to a site-wide run; accept it as a run proposal."
    );
  }
  const { page, ops, decide } = await acceptance(r, cs, input);
  const committed = await commitAgentChange(
    r.cms,
    page.id,
    page.draftVersion,
    ops,
    { summary: cs.summary, agentRunId: cs.threadId, decide }
  );
  return { revId: committed.revId, draftVersion: committed.draftVersion };
}

/** Accepts any pending proposal: through its run when it has one, else as a conversation's. */
export async function acceptChangeset(
  r: ReviewDeps,
  input: AcceptInput
): Promise<{ revId: string; draftVersion: number; runId?: string }> {
  const cs = await r.store.getChangeset(input.changesetId);
  if (cs && (await runOfChangeset(r.store, cs))) {
    const res = await acceptRunChangeset(r, input);
    return {
      revId: res.revId,
      draftVersion: res.draftVersion,
      runId: res.run.id,
    };
  }
  return acceptConversationChangeset(r, input);
}

/** Rejects any pending proposal (the page is untouched): through its run when it has one. */
export async function rejectChangeset(
  r: ReviewDeps,
  changesetId: string
): Promise<{ runId?: string }> {
  const cs = await r.store.getChangeset(changesetId);
  if (!cs) {
    throw new CmsError("NOT_FOUND", "Proposal not found.");
  }
  if (await runOfChangeset(r.store, cs)) {
    return { runId: (await rejectRunChangeset(r, changesetId)).run.id };
  }
  if (cs.status !== "pending") {
    throw new CmsError(
      "LIVE_CHANGED",
      `This proposal was already ${cs.status}.`
    );
  }
  const groups =
    cs.kind === "ops" ? groupsOf((cs.payload as { ops: Op[] }).ops) : ["seo"];
  if (
    !(await r.store.decide(
      cs.id,
      "rejected",
      { accepted: [], rejected: groups },
      nowOf(r)
    ))
  ) {
    throw new CmsError("LIVE_CHANGED", "This proposal was already decided.");
  }
  return {};
}

/** Rejects a run's proposal: the page is untouched. */
export async function rejectRunChangeset(
  r: ReviewDeps,
  changesetId: string
): Promise<{ run: Run }> {
  const { cs, run, item } = await pendingRunChangeset(r, changesetId);
  const groups =
    cs.kind === "ops" ? groupsOf((cs.payload as { ops: Op[] }).ops) : ["seo"];
  const decided = await r.store.decide(
    cs.id,
    "rejected",
    { accepted: [], rejected: groups },
    nowOf(r)
  );
  if (!decided) {
    throw new CmsError("LIVE_CHANGED", "This proposal was already decided.");
  }
  const statuses = await itemStatuses(r.store, item);
  return {
    run: await mutateRun(
      r.store,
      run.id,
      (x) => decideItem(x, item.id, { statuses }),
      nowOf(r)
    ),
  };
}

/** The item's proposals still waiting. */
async function pendingOfItem(
  store: AgentStore,
  item: RunItem
): Promise<ChangesetRow[]> {
  return (await store.changesetsByIds(item.changesetIds)).filter(
    (c) => c.status === "pending"
  );
}

/**
 * The review queue's per-page decision. Accept: every pending proposal of the item (content
 * first, then SEO with the chosen variant, which must be given when there is one) and keep a draft
 * it created. Reject: reject them and archive the draft it created (only while it is still an
 * unpublished draft).
 */
export async function reviewRunItem(
  r: ReviewDeps,
  input: {
    runId: string;
    itemId: string;
    decision: "accept" | "reject";
    variant?: number;
  }
): Promise<{ run: Run }> {
  const run = await r.store.getRun(input.runId);
  if (!run) {
    throw new CmsError("NOT_FOUND", "Run not found.");
  }
  if (run.revertedAt) {
    throw new CmsError("LIVE_CHANGED", "This run was reverted.");
  }
  const item = run.items.find((i) => i.id === input.itemId);
  if (!item) {
    throw new CmsError("NOT_FOUND", "That item isn't in this run.");
  }
  if (item.status !== "proposed") {
    throw new CmsError(
      "LIVE_CHANGED",
      `/${item.slug} is ${item.status}; there is nothing to review.`
    );
  }
  const pending = (await pendingOfItem(r.store, item)).sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "ops" ? -1 : 1
  );
  let last: Run = run;
  if (input.decision === "accept") {
    if (pending.some((c) => c.kind === "seo") && input.variant === undefined) {
      throw new CmsError(
        "INVALID_OPS",
        "Choose which title and description to use."
      );
    }
    for (const cs of pending) {
      last = (
        await acceptRunChangeset(r, {
          changesetId: cs.id,
          ...(cs.kind === "seo" && { variant: input.variant }),
        })
      ).run;
    }
    if (!pending.length) {
      const statuses = await itemStatuses(r.store, item);
      last = await mutateRun(
        r.store,
        run.id,
        (x) => decideItem(x, item.id, { statuses, draft: "kept" }),
        nowOf(r)
      );
    }
    return { run: last };
  }
  for (const cs of pending) {
    last = (await rejectRunChangeset(r, cs.id)).run;
  }
  let draft: "archived" | undefined;
  if (item.createdPageId) {
    const page = await r.cms.repo.findPage({ id: item.createdPageId });
    if (page && page.status === "draft") {
      await archivePage(r.cms, page.id);
      draft = "archived";
    }
  }
  const statuses = await itemStatuses(r.store, item);
  last = await mutateRun(
    r.store,
    run.id,
    (x) => decideItem(x, item.id, { statuses, ...(draft && { draft }) }),
    nowOf(r)
  );
  return { run: last };
}

// ---------------------------------------------------------------------------------------------
// Revert this run

// biome-ignore lint/performance/noBarrelFile: the run review imports the revert helpers with the server functions, as in the source.
export { type RevertAction, revertsByDefault } from "@repo/cms-core/agent/run";

/**
 * What "Revert this run" will do, page by page. The run's changes are read from the revisions
 * tagged with it (`agent_run_id`), not from the run record. Drafts the run created are archived
 * (not when they were published since: the agent never publishes, and an archive would take a
 * live page down); pages with accepted changes are restored to the revision before the run's
 * first change on them.
 */
export async function revertPlan(
  r: ReviewDeps,
  run: Run
): Promise<RevertAction[]> {
  const actions: RevertAction[] = [];
  const byPage = new Map<string, RevisionMeta[]>();
  for (const rev of await r.cms.repo.runRevisions(run.id)) {
    byPage.set(rev.pageId, [...(byPage.get(rev.pageId) ?? []), rev]);
  }
  const created = new Set(
    run.items.flatMap((i) => (i.createdPageId ? [i.createdPageId] : []))
  );
  for (const id of created) {
    const page = await r.cms.repo.findPage({ id });
    if (!page) {
      continue;
    }
    const base = { pageId: id, slug: page.slug, title: page.title };
    if (page.status === "archived") {
      actions.push({ kind: "skip", ...base, reason: "Already archived." });
    } else if (page.status === "draft") {
      actions.push({
        kind: "archive",
        ...base,
        laterEdits: await editedAfter(r, page, run.id, byPage.get(id) ?? []),
      });
    } else {
      actions.push({
        kind: "skip",
        ...base,
        reason:
          "Published since the run: left alone. Unpublish it yourself to take it down.",
      });
    }
  }
  for (const [pageId, revs] of byPage) {
    if (created.has(pageId)) {
      continue;
    }
    const page = await r.cms.repo.findPage({ id: pageId });
    if (!page?.draftDoc) {
      continue;
    }
    const base = { pageId, slug: page.slug, title: page.title };
    const target = revs[0]!.parentRevId
      ? await r.cms.repo.getRevision(revs[0]!.parentRevId)
      : null;
    if (page.status === "archived") {
      actions.push({ kind: "skip", ...base, reason: "The page is archived." });
    } else if (!target) {
      actions.push({
        kind: "skip",
        ...base,
        reason: "No version from before the run to go back to.",
      });
    } else if (deepEqual(page.draftDoc, target.docJson)) {
      actions.push({
        kind: "skip",
        ...base,
        reason: "Already back to the version before the run.",
      });
    } else {
      const liveRev =
        page.status === "published" && page.liveRevId
          ? await r.cms.repo.getRevision(page.liveRevId)
          : null;
      const live =
        !!liveRev &&
        liveRev.createdAt.getTime() >= revs[0]!.createdAt.getTime() &&
        !deepEqual(liveRev.docJson, target.docJson);
      actions.push({
        kind: "restore",
        ...base,
        targetRevId: target.id,
        laterEdits: await editedAfter(r, page, run.id, revs),
        live,
      });
    }
  }
  return actions;
}

/**
 * Whether anyone else changed the page after the run's first revision on it: any revision since
 * that isn't one of the run's, or a draft that differs from the run's last revision (edits too
 * recent for a revision). A draft the run created in full (no run revision) counts as edited once
 * it has any revision at all (its first edit snapshots it).
 */
async function editedAfter(
  r: ReviewDeps,
  page: PageRow,
  runId: string,
  runRevs: RevisionMeta[]
): Promise<boolean> {
  const all = (await r.cms.repo.listRevisions(page.id)).reverse();
  if (!runRevs.length) {
    return all.length > 0;
  }
  const first = all.findIndex((x) => x.id === runRevs[0]!.id);
  if (
    all
      .slice(first + 1)
      .some((x) => x.agentRunId !== runId || x.kind !== "agent")
  ) {
    return true;
  }
  const last = await r.cms.repo.getRevision(runRevs.at(-1)!.id);
  return !(last && deepEqual(page.draftDoc, last.docJson));
}

export type RevertResult = {
  run: Run;
  actions: RevertAction[];
  applied: string[];
  alreadyReverted: boolean;
};

/**
 * "Revert this run": the chosen actions of `revertPlan` (`include`: page ids; by default every
 * page nobody edited after the run) in one go: a `restore` revision per page (the current draft is
 * kept in History first), archived drafts, proposals still pending rejected, and the run marked
 * reverted. Holds the site thread's turn lock throughout, so it is refused while an item or a
 * planning turn runs (or another tab reverts), and no item starts meanwhile. An item left
 * `running` by a request that died (the lock is free) is skipped. Retry-safe: the run is closed
 * (cancelled) before any page changes, a page already back where it was is skipped, and a reverted
 * run does nothing again.
 */
export async function revertRun(
  r: ReviewDeps,
  input: { runId: string; by: string | null; include?: string[] }
): Promise<RevertResult> {
  const first = await r.store.getRun(input.runId);
  if (!first) {
    throw new CmsError("NOT_FOUND", "Run not found.");
  }
  if (first.revertedAt) {
    return { run: first, actions: [], applied: [], alreadyReverted: true };
  }
  if (
    first.status === "proposed" ||
    first.status === "superseded" ||
    first.status === "discarded"
  ) {
    throw new CmsError("LIVE_CHANGED", "This plan never ran.");
  }
  const lockId = crypto.randomUUID();
  const when = nowOf(r);
  const lock = await r.store.acquireLock(first.threadId, lockId, when);
  if (!lock.ok) {
    throw new CmsError(
      "LIVE_CHANGED",
      "The run is busy: a page is being worked on (or another tab is reverting it). Pause the run, wait for the current page to finish, then revert."
    );
  }
  try {
    const run = await mutateRun(
      r.store,
      first.id,
      (x) => {
        if (x.revertedAt) {
          return x;
        }
        return {
          ...x,
          status: x.status === "active" ? "cancelled" : x.status,
          items: x.items.map((i) =>
            i.status === "pending" || i.status === "running"
              ? {
                  ...i,
                  status: "skipped" as const,
                  note: "The run was reverted.",
                }
              : i
          ),
        };
      },
      when
    );
    if (run.revertedAt) {
      return { run, actions: [], applied: [], alreadyReverted: true };
    }
    const actions = await revertPlan(r, run);
    const include = input.include ? new Set(input.include) : null;
    const applied: string[] = [];
    for (const a of actions) {
      if (
        a.kind === "skip" ||
        !(include ? include.has(a.pageId) : revertsByDefault(a))
      ) {
        continue;
      }
      if (a.kind === "archive") {
        await archivePage(r.cms, a.pageId);
      } else {
        const page = await r.cms.repo.findPage({ id: a.pageId });
        if (!page) {
          continue;
        }
        await restore(r.cms, a.pageId, a.targetRevId, page.draftVersion, {
          note: "Reverted agent run",
        });
      }
      applied.push(a.pageId);
    }
    await rejectPending(
      r.store,
      run.items.flatMap((i) => i.changesetIds),
      when
    );
    const next = await mutateRun(
      r.store,
      run.id,
      (x) => ({ ...x, revertedAt: when.toISOString(), revertedBy: input.by }),
      when
    );
    return { run: next, actions, applied, alreadyReverted: false };
  } finally {
    await r.store.releaseLock(first.threadId, lockId);
  }
}

/** Pending proposals of site-wide runs on this page, as the editor shows them. */
export async function siteProposalsFor(store: AgentStore, pageId: string) {
  return (await store.siteChangesets(pageId)).map(toChangeset);
}
