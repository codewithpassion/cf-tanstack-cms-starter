// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on stored rows, as in the source.
// biome-ignore-all lint/style/useErrorCause: the run error maps to a CmsError code; the message carries what the user needs, as in the source.
import type { BudgetStatus } from "@repo/cms-core/agent/budget-types";
import {
  DAY_RAISE_STEP_USD,
  THREAD_RAISE_STEPS_USD,
} from "@repo/cms-core/agent/limits";
import {
  type AgentModelOption,
  validateModels,
} from "@repo/cms-core/agent/models";
import {
  PLAN_ACTIONS,
  type PlanError,
  type PlanItemInput,
  validatePlan,
} from "@repo/cms-core/agent/plan";
import {
  approveRun,
  cancelRun,
  discardRun,
  newRunItems,
  type RevertAction,
  RunError,
  retryItem,
  skipItem,
} from "@repo/cms-core/agent/run";
import type {
  ChangesetStatus,
  ThreadSummary,
} from "@repo/cms-core/agent/types";
import { nanoid } from "nanoid";
import { z } from "zod";
import { adminResult } from "../cms/admin-errors";
import type { AdminResult, EditorPageWire } from "../cms/admin-result";
import { bindDeps } from "../cms/bind";
import { editorPage } from "../cms/history-admin";
import { CmsError, type ServiceDeps } from "../cms/pages-service";
import { type AltTextDeps, suggestAltText } from "./alt-text";
import { budgetDay, DEFAULT_BUDGET_TIME_ZONE, loadBudget } from "./budget";
import { modelOptions, type ProviderAvailability } from "./models";
import { recordAgentRevision } from "./revision";
import {
  acceptRunChangeset,
  mutateRun,
  rejectRunChangeset,
  revertPlan,
  revertRun,
  reviewRunItem,
  runOfChangeset,
  siteProposalsFor,
} from "./runs";
import {
  type AgentStore,
  type BudgetSettings,
  DEFAULT_BUDGET_SETTINGS,
  toChangeset,
} from "./store-port";
import { threadDetail } from "./thread-view";

/**
 * The editor's AI tab and /admin/agent as plain functions over ports (the source's admin server
 * functions minus the server-function wrappers, `assertAdmin`, `env` and `href` handling, D8).
 * The web router asserts admin first, then calls these with the parsed input; each returns the
 * `adminResult` union. Input schemas are exported for the router's `.input()`; the functions parse
 * again, so a caller that skips tRPC still gets validated input.
 *
 * Runs and changesets used to travel as JSON text because the server-function serializer rejected
 * open JSON; tRPC with superjson doesn't need that, so these return the objects (the `...Json`
 * fields are gone).
 */

export type AgentAdminDeps = {
  store: AgentStore;
  /** The page service's deps with the admin as `author`. */
  cms: ServiceDeps;
  /** What the environment offers, for the model list (the adapter reads the key and binding). */
  availability: ProviderAvailability;
  /** The signed-in admin: the email is recorded on overrides, settings, models and reverts. */
  actor: { userId: string | null; email: string | null };
  /** The site's IANA zone: "today" for the daily cap. Default "UTC" (D14). */
  timeZone?: string;
  now?: () => number;
  genId?: () => string;
};

const nowOf = (d: AgentAdminDeps) => (d.now ?? Date.now)();
const idOf = (d: AgentAdminDeps) => (d.genId ?? nanoid)();
const zoneOf = (d: AgentAdminDeps) => d.timeZone ?? DEFAULT_BUDGET_TIME_ZONE;
const review = (d: AgentAdminDeps) => ({
  cms: d.cms,
  store: d.store,
  now: () => new Date(nowOf(d)),
});

/** Run-state refusals ("already done") come back as results, like the page service's. */
function runResult<T extends object>(
  fn: () => Promise<T>
): Promise<AdminResult<T>> {
  return adminResult(async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RunError) {
        throw new CmsError(
          err.code === "NOT_FOUND" ? "NOT_FOUND" : "LIVE_CHANGED",
          err.message
        );
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Input schemas

const id = (max: number) => z.string().max(max);
const variantSchema = z.number().int().min(0).max(2).optional();
const keyList = z.array(z.string().max(64)).max(200);

export const listThreadsInput = z.object({
  pageId: id(64),
  scope: z.enum(["page", "site"]).optional(),
});
export const getThreadInput = z.object({ threadId: id(64), pageId: id(64) });

const RAISES = [...THREAD_RAISE_STEPS_USD, DAY_RAISE_STEP_USD];
const raiseAmount = z
  .number()
  .refine((n) => RAISES.includes(n as never), {
    message: `Expected "amount" to be one of ${RAISES.join(", ")} or null`,
  })
  .nullable();
export const raiseBudgetInput = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("thread"),
    threadId: id(64),
    amount: raiseAmount,
  }),
  z.object({ scope: z.literal("run"), runId: id(80), amount: raiseAmount }),
  z.object({ scope: z.literal("day"), amount: raiseAmount }),
]);
export const takeOverInput = z.object({ threadId: id(64) });

const MAX_CAP_USD = 10_000;
const cap = z.number().finite().gt(0).max(MAX_CAP_USD).nullable();
export const saveSettingsInput = z.object({
  threadCapUsd: cap,
  dailyCapUsd: cap,
});
export const saveModelsInput = z.object({ models: z.unknown() });

export const decideChangesetInput = z.object({
  changesetId: id(64),
  status: z.enum(["accepted", "rejected", "partial"]),
  accepted: keyList,
  rejected: keyList,
  variant: variantSchema,
  /** The saved draft's version; required for an accept. */
  draftVersion: z.number().int().min(0).optional(),
});

export const suggestAltTextInput = z.object({
  id: z.string(),
  context: z.string().optional(),
});

export const runIdInput = z.object({ runId: id(80) });
export const runItemInput = z.object({ runId: id(80), itemId: id(80) });
const planItem = z.object({
  slug: id(200),
  action: z.enum(PLAN_ACTIONS),
  intent: id(4000),
  from: id(200).optional(),
});
export const approveRunInput = z.object({
  runId: id(80),
  items: z.array(planItem).max(50),
});
export const reviewRunItemInput = z.object({
  runId: id(80),
  itemId: id(80),
  decision: z.enum(["accept", "reject"]),
  variant: variantSchema,
});
export const acceptRunChangesetInput = z.object({
  changesetId: id(64),
  groups: keyList.optional(),
  variant: variantSchema,
  draftVersion: z.number().int().min(0),
  confirmConflicts: keyList.default([]),
});
export const rejectRunChangesetInput = z.object({ changesetId: id(64) });
export const revertRunInput = z.object({
  runId: id(80),
  /** Page ids ticked in the dialog. */
  include: z.array(id(64)).max(100),
});
export const siteProposalsInput = z.object({ pageId: id(64) });
export const threadRunsInput = z.object({ threadId: id(64) });

// ---------------------------------------------------------------------------------------------
// AI tab

/** The page's agent threads (or, `scope: "site"`, the site-wide ones), newest first, with their cost, and the caps before a thread exists. */
export function listAgentThreads(
  d: AgentAdminDeps,
  raw: z.input<typeof listThreadsInput>
): Promise<AdminResult<{ threads: ThreadSummary[]; budget: BudgetStatus }>> {
  const input = listThreadsInput.parse(raw);
  return adminResult(async () => {
    const [threads, budget] = await Promise.all([
      input.scope === "site"
        ? d.store.listSiteThreads()
        : d.store.listThreads(input.pageId),
      loadBudget(d.store, null, nowOf(d), null, zoneOf(d)),
    ]);
    return { threads, budget };
  });
}

/** One thread of this page as the chat shows it. */
export function getAgentThread(
  d: AgentAdminDeps,
  raw: z.input<typeof getThreadInput>
): Promise<AdminResult<{ detail: ReturnType<typeof threadDetail> }>> {
  const input = getThreadInput.parse(raw);
  return adminResult(async () => {
    const thread = await d.store.getThread(input.threadId);
    if (
      !thread ||
      (thread.scope !== "site" && thread.pageId !== input.pageId)
    ) {
      throw new CmsError("NOT_FOUND", "Conversation not found.");
    }
    const [messages, changesets, budget, models] = await Promise.all([
      d.store.messages(input.threadId),
      d.store.changesets(input.threadId),
      loadBudget(d.store, input.threadId, nowOf(d), null, zoneOf(d)),
      modelOptions(d.availability, d.store),
    ]);
    return {
      detail: threadDetail(
        thread,
        messages,
        changesets.map(toChangeset),
        budget,
        models
      ),
    };
  });
}

/**
 * Raises a spending cap: `thread` a conversation's (the site thread, or a run item's own thread),
 * `run` a site-wide run's, `day` today's (a date in the site's zone). `amount` is one of the
 * offered steps, or null for no limit. Recorded with who and when.
 */
export function raiseAgentBudget(
  d: AgentAdminDeps,
  raw: z.input<typeof raiseBudgetInput>
): Promise<AdminResult<{ budget: BudgetStatus }>> {
  const input = raiseBudgetInput.parse(raw);
  const threadId = input.scope === "thread" ? input.threadId : null;
  const runId = input.scope === "run" ? input.runId : null;
  return adminResult(async () => {
    if (threadId && !(await d.store.getThread(threadId))) {
      throw new CmsError("NOT_FOUND", "Conversation not found.");
    }
    const run = runId ? await d.store.getRun(runId) : null;
    if (runId && !run) {
      throw new CmsError("NOT_FOUND", "Run not found.");
    }
    const now = nowOf(d);
    const runLine = run ? { id: run.id, spentUsd: run.costUsd } : null;
    await d.store.addOverride({
      id: idOf(d),
      scope: input.scope,
      threadId: threadId ?? runId,
      day: input.scope === "day" ? budgetDay(now, zoneOf(d)) : null,
      amountUsd: input.amount,
      createdBy: d.actor.email,
      createdAt: new Date(now).toISOString(),
    });
    return {
      budget: await loadBudget(d.store, threadId, now, runLine, zoneOf(d)),
    };
  });
}

/** "Take over": clears another tab's turn lock once it is old enough (and tells that turn to stop). */
export function takeOverAgentThread(
  d: AgentAdminDeps,
  raw: z.input<typeof takeOverInput>
): Promise<AdminResult<{ released: boolean }>> {
  const input = takeOverInput.parse(raw);
  return adminResult(async () => ({
    released: await d.store.takeOver(input.threadId, new Date(nowOf(d))),
  }));
}

/** AI settings: the default caps, and whether they are the built-in defaults. */
export function getAgentSettings(
  d: AgentAdminDeps
): Promise<AdminResult<{ settings: BudgetSettings; saved: boolean }>> {
  return adminResult(async () => {
    const saved = await d.store.getSettings();
    return { settings: saved ?? DEFAULT_BUDGET_SETTINGS, saved: !!saved };
  });
}

export function saveAgentSettings(
  d: AgentAdminDeps,
  raw: z.input<typeof saveSettingsInput>
): Promise<AdminResult<{ settings: BudgetSettings }>> {
  const input = saveSettingsInput.parse(raw);
  const round = (v: number | null) =>
    v === null ? null : Math.round(v * 100) / 100;
  const settings: BudgetSettings = {
    threadCapUsd: round(input.threadCapUsd),
    dailyCapUsd: round(input.dailyCapUsd),
  };
  return adminResult(async () => {
    await d.store.saveSettings(settings, d.actor.email, new Date(nowOf(d)));
    return { settings };
  });
}

/** The agent models with whether each can run here: the AI tab's model picker and the setup card. */
export function getAgentModels(
  d: AgentAdminDeps
): Promise<AdminResult<{ models: AgentModelOption[]; saved: boolean }>> {
  return adminResult(async () => {
    const [models, saved] = await Promise.all([
      modelOptions(d.availability, d.store),
      d.store.getModels(),
    ]);
    return { models, saved: !!saved };
  });
}

/** Saves the agent model list (validated: see `validateModels`). Existing threads keep their model. */
export function saveAgentModels(
  d: AgentAdminDeps,
  raw: z.input<typeof saveModelsInput>
): Promise<AdminResult<{ models: AgentModelOption[] }>> {
  const checked = validateModels(saveModelsInput.parse(raw).models);
  return adminResult(async () => {
    if (!checked.ok) {
      throw new CmsError("INVALID_DOC", checked.message);
    }
    await d.store.saveModels(checked.models, d.actor.email, new Date(nowOf(d)));
    return { models: await modelOptions(d.availability, d.store) };
  });
}

/**
 * Records the user's decision on a pending changeset. For an accept (whole or partial) the editor
 * has already applied and saved the ops; `draftVersion` is the saved draft, which becomes an
 * `agent` revision (one entry in History). A reject changes nothing on the page.
 */
export function decideChangeset(
  d: AgentAdminDeps,
  raw: z.input<typeof decideChangesetInput>
): Promise<AdminResult<{ revId: string | null }>> {
  const input = decideChangesetInput.parse(raw);
  const status: ChangesetStatus = input.status;
  return adminResult(async () => {
    if (status !== "rejected" && input.draftVersion === undefined) {
      throw new CmsError(
        "STALE_DRAFT",
        "The draft hasn't saved yet. Wait for it to save and retry."
      );
    }
    const cs = await d.store.getChangeset(input.changesetId);
    if (!cs) {
      throw new CmsError("NOT_FOUND", "Changeset not found.");
    }
    if (cs.status !== "pending") {
      throw new CmsError(
        "LIVE_CHANGED",
        `This proposal was already ${cs.status}.`
      );
    }
    if (await runOfChangeset(d.store, cs)) {
      if (status !== "rejected") {
        throw new CmsError(
          "LIVE_CHANGED",
          "Accept a run's proposal with acceptRunChangeset."
        );
      }
      await rejectRunChangeset(review(d), input.changesetId);
      return { revId: null };
    }
    let revId: string | null = null;
    if (status !== "rejected") {
      const rev = await recordAgentRevision(d.cms, {
        pageId: cs.pageId,
        draftVersion: input.draftVersion as number,
        summary: cs.summary,
        runId: cs.threadId,
      });
      revId = rev.id;
    }
    const decided = await d.store.decide(
      input.changesetId,
      status,
      {
        accepted: input.accepted,
        rejected: input.rejected,
        ...(input.variant !== undefined && { variant: input.variant }),
        revId,
      },
      new Date(nowOf(d))
    );
    if (!decided) {
      throw new CmsError("LIVE_CHANGED", "This proposal was already decided.");
    }
    return { revId };
  });
}

/** "Suggest alt text" in the media library: a short vision call (low effort). */
export function suggestAltTextFor(
  deps: AltTextDeps,
  raw: z.input<typeof suggestAltTextInput>
) {
  const input = suggestAltTextInput.parse(raw);
  return suggestAltText(deps, input.id, input.context?.slice(0, 300));
}

// ---------------------------------------------------------------------------------------------
// Site-wide runs

type PageRef = { slug: string; kind: "page" | "post"; status: "draft" };

/** Pages a run refers to, for links and titles. */
export type RunPageRef = {
  id: string;
  slug: string;
  title: string;
  status: string;
  kind: string;
};

async function pageRefs(d: AgentAdminDeps): Promise<RunPageRef[]> {
  return (await d.cms.repo.listPages()).map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    status: p.status,
    kind: p.kind,
  }));
}

/** One run with its proposals and the pages it refers to (/admin/agent's review queue). */
export function getRun(d: AgentAdminDeps, raw: z.input<typeof runIdInput>) {
  const input = runIdInput.parse(raw);
  return runResult(async () => {
    const run = await d.store.getRun(input.runId);
    if (!run) {
      throw new CmsError("NOT_FOUND", "Run not found.");
    }
    const [rows, pages, thread] = await Promise.all([
      d.store.changesetsByIds(run.items.flatMap((i) => i.changesetIds)),
      pageRefs(d),
      d.store.getThread(run.threadId),
    ]);
    return {
      detail: {
        run,
        changesets: rows.map(toChangeset),
        pages,
        thread: thread && {
          id: thread.id,
          title: thread.title,
          pageId: thread.pageId,
        },
      },
    };
  });
}

/** The site-wide conversation's runs (the AI tab's Site scope). */
export function threadRuns(
  d: AgentAdminDeps,
  raw: z.input<typeof threadRunsInput>
) {
  const input = threadRunsInput.parse(raw);
  return runResult(async () => ({
    runs: await d.store.listRuns({ threadId: input.threadId, limit: 20 }),
  }));
}

/** Every run and the site-wide conversations (the /admin/agent loader). */
export function listRuns(d: AgentAdminDeps) {
  return adminResult(async () => {
    const [runs, threads] = await Promise.all([
      d.store.listRuns({ limit: 100 }),
      d.store.listSiteThreads(),
    ]);
    return { runs, threads };
  });
}

/** Approves the plan as edited in the checklist (checked again first). */
export function approveRunPlan(
  d: AgentAdminDeps,
  raw: z.input<typeof approveRunInput>
) {
  const input = approveRunInput.parse(raw);
  return runResult(
    async (): Promise<{
      run: Awaited<ReturnType<typeof mutateRun>> | null;
      errors: PlanError[];
    }> => {
      const refs: PageRef[] = (await pageRefs(d)).map((p) => ({
        slug: p.slug,
        kind: p.kind as "page" | "post",
        status: p.status as "draft",
      }));
      const checked = validatePlan(input.items as PlanItemInput[], refs);
      if (!checked.ok) {
        return { run: null, errors: checked.errors };
      }
      const run = await mutateRun(d.store, input.runId, (r) =>
        approveRun(
          r,
          newRunItems(checked.items, () => idOf(d)),
          new Date(nowOf(d))
        )
      );
      return { run, errors: [] };
    }
  );
}

/** Discards a plan that wasn't approved. */
export function discardRunPlan(
  d: AgentAdminDeps,
  raw: z.input<typeof runIdInput>
) {
  const input = runIdInput.parse(raw);
  return runResult(async () => ({
    run: await mutateRun(d.store, input.runId, (r) => discardRun(r)),
  }));
}

/**
 * Stops a run for good (staged proposals stay reviewable). A page still running (another tab) is
 * asked to stop; what it stages after the cancel is rejected when it ends (`endItem`).
 */
export function cancelRunNow(
  d: AgentAdminDeps,
  raw: z.input<typeof runIdInput>
) {
  const input = runIdInput.parse(raw);
  return runResult(async () => {
    const running = (await d.store.getRun(input.runId))?.items.some(
      (i) => i.status === "running"
    );
    const run = await mutateRun(d.store, input.runId, (r) => cancelRun(r));
    if (running) {
      await d.store.requestStop(run.threadId);
    }
    return { run };
  });
}

/** Skips a pending or failed item. */
export function skipRunItem(
  d: AgentAdminDeps,
  raw: z.input<typeof runItemInput>
) {
  const input = runItemInput.parse(raw);
  return runResult(async () => ({
    run: await mutateRun(d.store, input.runId, (r) =>
      skipItem(r, input.itemId)
    ),
  }));
}

/** Runs a failed or skipped item again (on resume). */
export function retryRunItem(
  d: AgentAdminDeps,
  raw: z.input<typeof runItemInput>
) {
  const input = runItemInput.parse(raw);
  return runResult(async () => ({
    run: await mutateRun(d.store, input.runId, (r) =>
      retryItem(r, input.itemId)
    ),
  }));
}

/** The review queue's per-page Accept / Reject. */
export function reviewItem(
  d: AgentAdminDeps,
  raw: z.input<typeof reviewRunItemInput>
) {
  const input = reviewRunItemInput.parse(raw);
  return runResult(async () => {
    const { run } = await reviewRunItem(review(d), {
      runId: input.runId,
      itemId: input.itemId,
      decision: input.decision,
      ...(input.variant !== undefined && { variant: input.variant }),
    });
    return { run };
  });
}

/**
 * Accepts a run's proposal from the editor: the chosen blocks (or SEO variant) in one server-side
 * commit, after the editor saved (`draftVersion`). Returns the new draft for the editor to load.
 */
export function acceptRunProposal(
  d: AgentAdminDeps,
  raw: z.input<typeof acceptRunChangesetInput>
): Promise<
  AdminResult<{
    revId: string;
    editor: EditorPageWire;
    run: Awaited<ReturnType<typeof mutateRun>>;
  }>
> {
  const input = acceptRunChangesetInput.parse(raw);
  return runResult(async () => {
    const res = await acceptRunChangeset(review(d), {
      changesetId: input.changesetId,
      draftVersion: input.draftVersion,
      confirmConflicts: input.confirmConflicts,
      ...(input.groups !== undefined && { groups: input.groups }),
      ...(input.variant !== undefined && { variant: input.variant }),
    });
    const cs = await d.store.getChangeset(input.changesetId);
    return {
      revId: res.revId,
      editor: await editorPage(d.cms, (cs as { pageId: string }).pageId),
      run: res.run,
    };
  });
}

export function rejectRunProposal(
  d: AgentAdminDeps,
  raw: z.input<typeof rejectRunChangesetInput>
) {
  const input = rejectRunChangesetInput.parse(raw);
  return runResult(async () => ({
    run: (await rejectRunChangeset(review(d), input.changesetId)).run,
  }));
}

/** What "Revert this run" would do, page by page (the confirm dialog: pages edited after the run start unticked). */
export function previewRevert(
  d: AgentAdminDeps,
  raw: z.input<typeof runIdInput>
): Promise<AdminResult<{ actions: RevertAction[] }>> {
  const input = runIdInput.parse(raw);
  return runResult(async () => {
    const run = await d.store.getRun(input.runId);
    if (!run) {
      throw new CmsError("NOT_FOUND", "Run not found.");
    }
    return { actions: run.revertedAt ? [] : await revertPlan(review(d), run) };
  });
}

/** Reverts the run: `include` is the pages ticked in the dialog (page ids). */
export function revertTheRun(
  d: AgentAdminDeps,
  raw: z.input<typeof revertRunInput>
) {
  const input = revertRunInput.parse(raw);
  return runResult(async () => {
    const res = await revertRun(review(d), {
      runId: input.runId,
      by: d.actor.email,
      include: input.include,
    });
    return {
      run: res.run,
      actions: res.actions,
      applied: res.applied,
      alreadyReverted: res.alreadyReverted,
    };
  });
}

/** Pending proposals from site-wide runs on this page, for the editor's AI tab (ghost overlay, per-block accept). */
export function siteProposals(
  d: AgentAdminDeps,
  raw: z.input<typeof siteProposalsInput>
) {
  const input = siteProposalsInput.parse(raw);
  return runResult(async () => ({
    changesets: await siteProposalsFor(d.store, input.pageId),
  }));
}

export const createAgentAdminService = (deps: AgentAdminDeps) =>
  bindDeps(deps, {
    listAgentThreads,
    getAgentThread,
    raiseAgentBudget,
    takeOverAgentThread,
    getAgentSettings,
    saveAgentSettings,
    getAgentModels,
    saveAgentModels,
    decideChangeset,
    getRun,
    threadRuns,
    listRuns,
    approveRunPlan,
    discardRunPlan,
    cancelRunNow,
    skipRunItem,
    retryRunItem,
    reviewItem,
    acceptRunProposal,
    rejectRunProposal,
    previewRevert,
    revertTheRun,
    siteProposals,
  });
