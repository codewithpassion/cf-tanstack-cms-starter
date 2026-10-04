// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/complexity/useOptionalChain: ported verbatim; explicit checks kept as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; constructor parameter properties as in the source.
// biome-ignore-all lint/style/useDefaultSwitchClause: switches over closed unions; TypeScript checks exhaustiveness, as in the source.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/style/useReadonlyClassProperties: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: intentional no-op callbacks and ignored failures, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
import type { BudgetStatus } from "@repo/cms-core/agent/budget-types";
import {
  conflicts,
  groupsOf,
  opsToApply,
  proposedDoc,
  seoOpFor,
} from "@repo/cms-core/agent/changeset";
import { addUsage, formatUsd } from "@repo/cms-core/agent/cost";
import {
  type AgentModelOption,
  DEFAULT_MODEL,
  type ModelRef,
} from "@repo/cms-core/agent/models";
import type { PlanError, PlanItemInput } from "@repo/cms-core/agent/plan";
import { nextItem, type Run } from "@repo/cms-core/agent/run";
import type {
  AgentEvent,
  Changeset,
  ModelOff,
  ThreadFull,
  ThreadItem,
  ThreadSummary,
  UsageSummary,
} from "@repo/cms-core/agent/types";
import { applyOps } from "@repo/cms-core/ops/apply-ops";
import type { Device, PageDoc } from "@repo/cms-core/types";
import type { turnBodySchema } from "@repo/services/agent/turn";
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { z } from "zod";
import { getTrpc } from "#/integrations/trpc/client";
import { initOf } from "../../editor/history-panel";
import { signedOutAsResult } from "../../editor/signed-out";
import type { EditorStore } from "../../editor/store";
import { readEvents } from "./sse";

/**
 * The editor's AI tab state (docs/cms-plan.md §4.4), framework-free like EditorStore: threads of
 * the page, the open thread's transcript (live while a turn streams), its changesets, and which
 * changeset is shown on the canvas as a ghost overlay. Accepting applies the accepted groups'
 * ops through the editor store (one undo step), waits for the save, then records an `agent`
 * revision; rejecting changes nothing on the page. Spending caps, a busy thread and a full thread
 * pause the chat with a way forward (raise the limit, take over, start a new thread). A new
 * thread starts on the model picked in the tab (AI settings list which); it keeps that model, and
 * once that model is turned off the thread offers a new one on another model.
 *
 * Site scope (Phase 6): site-wide conversations plan multi-page runs. The agent's plan arrives as
 * an editable checklist; approving it starts the run, which this view drives one item per request
 * (`driveRun`): it stops when a turn pauses (Stop, a spending cap, a busy thread) and resumes from
 * the next pending item. Proposals a run made for this page are reviewed here like the page's own
 * (`siteProposals`), but accepted on the server in one commit, so "Revert this run" is exact.
 */

type Ctx = { device: Device; selectedKey: string | null };
/** What to send again once a pause is resolved. */
type Retry =
  | {
      kind: "send";
      text: string;
      images: { id: string; url: string }[];
      ctx: Ctx;
    }
  | { kind: "continue"; ctx: Ctx }
  | { kind: "item"; runId: string; itemId: string; ctx: Ctx };

export type AgentScope = "page" | "site";

export type AgentState = {
  threads: ThreadSummary[];
  threadId: string | null;
  items: ThreadItem[];
  changesets: Changeset[];
  usage: UsageSummary | null;
  threadCostUsd: number;
  loading: boolean;
  streaming: boolean;
  error: string | null;
  /** The ops changeset shown on the canvas, with the groups (blocks) still selected for accepting. */
  preview: { id: string; groups: string[] } | null;
  /** Busy accepting/rejecting this changeset. */
  deciding: string | null;
  /** The spending caps (the thread's, or only the day's before a thread exists). */
  budget: BudgetStatus | null;
  /** Paused on a spending cap: raising it sends `retry` (if anything was paused). */
  blocked: {
    budget: BudgetStatus;
    message: string;
    retry: Retry | null;
  } | null;
  /** Another tab is running a turn on this thread. */
  busy: {
    message: string;
    lockAgeMs: number;
    takeoverAfterMs: number;
    retry: Retry;
  } | null;
  /** The thread takes no new messages. */
  full: ThreadFull | null;
  /** The thread's model is turned off or removed: it takes no new messages. */
  modelOff: ModelOff | null;
  /** Text to put in the composer (a summary to start a new thread with). */
  draft: string | null;
  /** The agent models from AI settings, with whether each can run here. */
  models: AgentModelOption[];
  /** The model a new thread starts on. */
  newModel: ModelRef;
  /** This page's conversations, or the site-wide ones. */
  scope: AgentScope;
  /** Site scope: the open conversation's runs, newest first (plans included). */
  runs: Run[];
  /** The run being driven item by item. */
  driving: string | null;
  /** "Pause after this page" was pressed: the run stops once the current page is done. */
  pausing: boolean;
  /** Pending proposals from site-wide runs on this page. */
  siteProposals: Changeset[];
};

const LOCK =
  "You are reviewing the agent's proposal. Accept or reject it, or close the review, to edit.";

/** The agent route's request body (services `turnBodySchema`, as sent). */
type TurnBody = z.input<typeof turnBodySchema>;

const agent = () => getTrpc().cms.agent;
const agentRuns = () => getTrpc().cms.agentRuns;

export class AgentView {
  private state: AgentState = {
    threads: [],
    threadId: null,
    items: [],
    changesets: [],
    usage: null,
    threadCostUsd: 0,
    loading: false,
    streaming: false,
    error: null,
    preview: null,
    deciding: null,
    budget: null,
    blocked: null,
    busy: null,
    full: null,
    modelOff: null,
    draft: null,
    models: [],
    newModel: DEFAULT_MODEL,
    scope: "page",
    runs: [],
    driving: null,
    pausing: false,
    siteProposals: [],
  };
  /** Pause asked for: the run stops after the current item. */
  private pauseRun = false;
  /** `?review=<changesetId>`: open that proposal once it's loaded. */
  private reviewOnLoad: string | null = null;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  /** Where the current model call's items start (a retried call drops them). */
  private callStart = 0;

  constructor(
    private readonly store: EditorStore,
    private readonly pageId: string,
    private readonly notify: (message: string, error?: boolean) => void
  ) {}

  getState = (): AgentState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AgentState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) {
      l();
    }
  }

  // --- Threads -------------------------------------------------------------------------------

  /** Switches between this page's conversations and the site-wide ones. */
  async setScope(scope: AgentScope): Promise<void> {
    if (
      this.state.streaming ||
      this.state.driving ||
      scope === this.state.scope
    ) {
      return;
    }
    this.set({ scope, threads: [], runs: [] });
    await this.openThread(null);
  }

  async loadThreads(): Promise<void> {
    try {
      const res = await agent().listAgentThreads.query({
        pageId: this.pageId,
        scope: this.state.scope,
      });
      if (res.ok) {
        this.set({
          threads: res.threads,
          ...(!this.state.threadId && { budget: res.budget }),
        });
      }
    } catch (err) {
      this.set({ error: message(err) });
    }
  }

  /** The model list for the new-thread picker; picks the default model, or the first one that can run. */
  async loadModels(): Promise<void> {
    try {
      const res = await agent().getAgentModels.query();
      if (!res.ok) {
        return;
      }
      const usable = res.models.filter((m) => m.enabled && m.available);
      const current = usable.find(
        (m) =>
          m.provider === this.state.newModel.provider &&
          m.id === this.state.newModel.id
      );
      const pick =
        current ??
        usable.find(
          (m) =>
            m.provider === DEFAULT_MODEL.provider && m.id === DEFAULT_MODEL.id
        ) ??
        usable[0];
      this.set({
        models: res.models,
        ...(pick && { newModel: { provider: pick.provider, id: pick.id } }),
      });
    } catch (err) {
      this.set({ error: message(err) });
    }
  }

  /** Picks the model the next new thread starts on. */
  setNewModel(ref: ModelRef) {
    this.set({ newModel: ref });
  }

  async openThread(id: string | null): Promise<void> {
    if (this.state.streaming) {
      return;
    }
    this.closePreview();
    const cleared = {
      blocked: null,
      busy: null,
      full: null,
      modelOff: null,
      error: null,
    };
    if (!id) {
      this.set({
        threadId: null,
        items: [],
        changesets: [],
        usage: null,
        threadCostUsd: 0,
        runs: [],
        ...cleared,
      });
      return this.loadThreads();
    }
    this.set({ loading: true, threadId: id, ...cleared });
    try {
      const res = await agent().getAgentThread.query({
        threadId: id,
        pageId: this.pageId,
      });
      if (!res.ok) {
        return this.set({ loading: false, error: res.message });
      }
      const { detail } = res;
      this.set({
        loading: false,
        items: detail.items,
        changesets: detail.changesets,
        usage: detail.usage,
        threadCostUsd: detail.thread.costUsd,
        budget: detail.budget,
        full: detail.full,
        modelOff: detail.modelOff,
      });
      if (this.state.scope === "site") {
        await this.loadRuns();
      }
      // At a cap: raising it continues a turn that paused there.
      if (detail.budget.blocked) {
        // A site-wide conversation paused in a run item resumes the run (its Resume button) rather than continuing.
        const retry: Retry | null =
          detail.canContinue && this.state.scope === "page"
            ? {
                kind: "continue",
                ctx: { device: "desktop", selectedKey: null },
              }
            : null;
        this.set({
          blocked: {
            budget: detail.budget,
            message: budgetMessage(detail.budget),
            retry,
          },
        });
      }
    } catch (err) {
      this.set({ loading: false, error: message(err) });
    }
  }

  /** Starts a new conversation with `summary` in the composer (a full thread's "Start a new thread"). */
  startNewThread(summary: string) {
    void this.openThread(null).then(() => this.set({ draft: summary }));
  }

  /** A turned-off model's "Start a new thread with …": the new conversation uses `next`, with `summary` in the composer. */
  startNewThreadWith(next: ModelRef, summary: string) {
    this.setNewModel({ provider: next.provider, id: next.id });
    this.startNewThread(summary);
  }

  /** The composer took the draft. */
  takeDraft() {
    if (this.state.draft !== null) {
      this.set({ draft: null });
    }
  }

  // --- Sending -------------------------------------------------------------------------------

  /** Saves the draft, then streams one turn. `images`: media ids already uploaded. */
  async send(
    text: string,
    images: { id: string; url: string }[],
    ctx: Ctx
  ): Promise<void> {
    if (this.state.streaming || !text.trim()) {
      return;
    }
    await this.run({ kind: "send", text, images, ctx });
  }

  /** Continues a turn that paused on a spending cap. */
  async continueTurn(ctx: Ctx): Promise<void> {
    if (this.state.streaming) {
      return;
    }
    await this.run({ kind: "continue", ctx });
  }

  private async run(req: Retry): Promise<void> {
    this.closePreview();
    await this.store.save();
    const snap = this.store.getSnapshot();
    if (snap.status !== "saved") {
      this.notify(
        "Save the draft first (it has unsaved or refused changes).",
        true
      );
      return;
    }
    const before = this.state.items;
    const items =
      req.kind === "send"
        ? [
            ...before,
            {
              kind: "user" as const,
              id: `local-${this.seq++}`,
              text: req.text,
              images: req.images.map((i) => i.url),
            },
          ]
        : before;
    this.set({
      streaming: true,
      error: null,
      blocked: null,
      busy: null,
      items,
    });
    this.abort = new AbortController();
    let done = false;
    try {
      const turn: TurnBody = {
        pageId: this.pageId,
        ...(this.state.threadId && { threadId: this.state.threadId }),
        ...(req.kind === "send"
          ? {
              message: req.text,
              ...(req.images.length && {
                images: req.images.map((i) => i.id),
              }),
            }
          : req.kind === "item"
            ? { runItem: { runId: req.runId, itemId: req.itemId } }
            : { continue: true as const }),
        ...(!this.state.threadId && {
          model: this.state.newModel,
          scope: this.state.scope,
        }),
        context: {
          device: req.ctx.device,
          selectedKey: req.ctx.selectedKey,
          draftVersion: snap.draftVersion,
        },
      };
      const res = await fetch("/admin/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(turn),
        signal: this.abort.signal,
      });
      if (!(res.ok && res.body)) {
        const body = (await res.json().catch(() => null)) as PauseBody | null;
        // Paused before anything ran: take the optimistic message back out, keep it for the retry.
        if (body?.code === "BUDGET" && body.budget) {
          return this.set({
            items: before,
            budget: body.budget,
            blocked: {
              budget: body.budget,
              message: body.message ?? "",
              retry: req,
            },
          });
        }
        if (body?.code === "BUSY") {
          return this.set({
            items: before,
            busy: {
              message: body.message ?? "",
              lockAgeMs: body.lockAgeMs ?? 0,
              takeoverAfterMs: body.takeoverAfterMs ?? 0,
              retry: req,
            },
          });
        }
        if (body?.code === "THREAD_FULL" && body.full) {
          return this.set({ items: before, full: body.full });
        }
        if (body?.code === "MODEL_OFF" && body.modelOff) {
          return this.set({ items: before, modelOff: body.modelOff });
        }
        if (body?.code === "RUN_NOT_ACTIVE" || body?.code === "ITEM_DONE") {
          void this.loadRuns();
          return this.set({
            items: before,
            error: body.message ?? "The run changed.",
          });
        }
        throw new Error(
          body?.message ?? `The agent request failed (${res.status}).`
        );
      }
      await readEvents(res.body, (event) => {
        if (event.type === "done") {
          done = true;
        }
        this.handle(event, req);
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        this.set({ error: message(err) });
      } else if (!done) {
        this.push({
          kind: "notice",
          id: `live-${this.seq++}`,
          text: "Stopped.",
        });
      }
    } finally {
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
      }
      this.stopTimer = null;
      this.abort = null;
      this.set({ streaming: false });
      void this.loadThreads();
    }
  }

  /**
   * Stop: asks the server to abort the model call in flight, and keeps reading until it says it's
   * done (what the stopped call produced is not kept). Gives up reading after a few seconds.
   */
  stop() {
    const threadId = this.state.threadId;
    if (!this.abort) {
      return;
    }
    if (!threadId) {
      return this.abort.abort();
    }
    void fetch(`/admin/api/agent?threadId=${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    }).catch(() => this.abort?.abort());
    this.stopTimer = setTimeout(() => this.abort?.abort(), STOP_WAIT_MS);
  }

  /**
   * Raises a spending cap (`amount` null = no limit), then sends what was paused again. A thread
   * cap is the capped thread's (a run item's own thread during a run), a run cap the run's.
   */
  async raiseBudget(
    scope: "thread" | "run" | "day",
    amount: number | null
  ): Promise<void> {
    const blocked = this.state.blocked;
    if (!blocked || this.state.streaming) {
      return;
    }
    // An unknown thread or run id comes back as NOT_FOUND.
    const input =
      scope === "thread"
        ? {
            scope,
            amount,
            threadId: blocked.budget.threadId ?? this.state.threadId ?? "",
          }
        : scope === "run"
          ? { scope, amount, runId: blocked.budget.run?.runId ?? "" }
          : { scope, amount };
    const res = await signedOutAsResult(() =>
      agent().raiseAgentBudget.mutate(input)
    );
    if (!res.ok) {
      return this.notify(res.message, true);
    }
    this.set({ budget: res.budget, blocked: null });
    if (res.budget.blocked) {
      return this.set({
        blocked: {
          ...blocked,
          budget: res.budget,
          message: budgetMessage(res.budget),
        },
      });
    }
    if (blocked.retry?.kind === "item") {
      await this.driveRun(blocked.retry.runId, blocked.retry.ctx);
    } else if (blocked.retry) {
      await this.run(blocked.retry);
    }
  }

  /** Clears another tab's stale lock, then sends what was refused again. */
  async takeOver(): Promise<void> {
    const busy = this.state.busy;
    const threadId = this.state.threadId;
    if (!(busy && threadId)) {
      return;
    }
    const res = await signedOutAsResult(() =>
      agent().takeOverAgentThread.mutate({ threadId })
    );
    if (!res.ok) {
      return this.notify(res.message, true);
    }
    if (!res.released) {
      return this.notify(
        "The other tab's turn is still recent. Try again in a minute.",
        true
      );
    }
    this.set({ busy: null });
    if (busy.retry.kind === "item") {
      await this.driveRun(busy.retry.runId, busy.retry.ctx);
    } else {
      await this.run(busy.retry);
    }
  }

  private push(item: ThreadItem) {
    this.set({ items: [...this.state.items, item] });
  }

  private handle(event: AgentEvent, req: Retry) {
    const items = this.state.items;
    switch (event.type) {
      case "thread":
        if (this.state.threadId !== event.threadId) {
          const at = new Date().toISOString();
          const thread: ThreadSummary = {
            id: event.threadId,
            pageId: this.pageId,
            title: event.title,
            createdAt: at,
            updatedAt: at,
            costUsd: 0,
            provider: event.provider,
            model: event.model,
          };
          this.set({
            threadId: event.threadId,
            threads: [thread, ...this.state.threads],
          });
        }
        break;
      case "thread_gone":
        this.set({
          threadId: null,
          threads: this.state.threads.filter(
            (t) => t.id !== this.state.threadId
          ),
        });
        break;
      case "call_start":
        this.callStart = items.length;
        break;
      case "reset":
        this.set({ items: items.slice(0, this.callStart) });
        break;
      case "text": {
        const last = items.at(-1);
        if (last?.kind === "text" && last.id.startsWith("live-")) {
          this.set({
            items: [
              ...items.slice(0, -1),
              { ...last, text: last.text + event.text },
            ],
          });
        } else {
          this.push({
            kind: "text",
            id: `live-${this.seq++}`,
            text: event.text,
          });
        }
        break;
      }
      case "progress":
        this.push({
          kind: "progress",
          id: `live-${this.seq++}`,
          text: event.text,
          ...(event.reasoning && { reasoning: true }),
        });
        break;
      case "tool_start": {
        const i = items.findIndex(
          (it) => it.kind === "tool" && it.id === event.tool.id
        );
        const item: ThreadItem = {
          kind: "tool",
          id: event.tool.id,
          name: event.tool.name,
          label: event.tool.label,
          ok: null,
        };
        if (i >= 0) {
          this.set({
            items: items.map((it, j) =>
              j === i ? ({ ...it, label: event.tool.label } as ThreadItem) : it
            ),
          });
        } else {
          this.push(item);
        }
        break;
      }
      case "tool_end":
        this.set({
          items: items.map((it) =>
            it.kind === "tool" && it.id === event.id
              ? {
                  ...it,
                  ok: event.ok,
                  summary: event.summary,
                  ...(event.image && { image: event.image }),
                }
              : it
          ),
        });
        break;
      case "changeset": {
        const cs = event.changeset;
        const others = this.state.changesets.map((c) =>
          c.status === "pending" && c.kind === cs.kind && c.pageId === cs.pageId
            ? { ...c, status: "superseded" as const }
            : c
        );
        this.set({ changesets: [...others, cs] });
        break;
      }
      case "created":
        this.push({
          kind: "created",
          id: `live-${this.seq++}`,
          page: event.page,
        });
        break;
      case "plan":
      case "run":
        this.upsertRun(event.run);
        break;
      case "fallback":
        this.push({
          kind: "notice",
          id: `live-${this.seq++}`,
          text: `${event.from} declined this request; ${event.to} answered instead.`,
        });
        break;
      case "refusal": {
        // Text the declined call streamed before stopping is cut off.
        const marked = items.map((it, i) =>
          i >= this.callStart && it.kind === "text"
            ? { ...it, partial: true }
            : it
        );
        this.set({
          items: [
            ...marked,
            {
              kind: "refusal",
              id: `live-${this.seq++}`,
              category: event.category,
            },
          ],
        });
        break;
      }
      case "usage":
        this.set({
          threadCostUsd: event.threadCostUsd,
          usage: this.state.usage
            ? addUsage(this.state.usage, event.usage)
            : event.usage,
        });
        break;
      case "budget":
        this.set({ budget: event.budget });
        break;
      case "notice":
        this.push({
          kind: "notice",
          id: `live-${this.seq++}`,
          text: event.text,
        });
        break;
      case "error":
        this.push({
          kind: "notice",
          id: `live-${this.seq++}`,
          text: `Error: ${event.message}`,
        });
        break;
      case "done":
        if (event.stopReason === "aborted") {
          // The stopped call's output isn't kept: show that, and drop it from view.
          this.set({
            items: [
              ...items.slice(0, this.callStart),
              {
                kind: "notice",
                id: `live-${this.seq++}`,
                text: "Stopped. What the agent was writing wasn't kept.",
              },
            ],
          });
        } else if (event.stopReason === "stopped") {
          this.push({
            kind: "notice",
            id: `live-${this.seq++}`,
            text: "Stopped.",
          });
        } else if (
          event.stopReason === "budget" &&
          this.state.budget?.blocked
        ) {
          // Paused between steps: raising the cap continues the turn (a run item runs again).
          const retry: Retry =
            req.kind === "item" ? req : { kind: "continue", ctx: req.ctx };
          this.set({
            blocked: {
              budget: this.state.budget,
              message: budgetMessage(this.state.budget),
              retry,
            },
          });
        }
        break;
    }
  }

  // --- Site-wide runs --------------------------------------------------------------------------

  private upsertRun(run: Run) {
    const others = this.state.runs.filter((r) => r.id !== run.id);
    const runs = [run, ...others].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    this.set({ runs });
    // A run item may have staged a proposal for the page open in the editor.
    if (run.items.some((i) => i.pageId === this.pageId)) {
      void this.loadSiteProposals();
    }
  }

  /** The open site-wide conversation's runs. */
  async loadRuns(): Promise<void> {
    const threadId = this.state.threadId;
    if (!threadId || this.state.scope !== "site") {
      return;
    }
    try {
      const res = await agentRuns().threadRuns.query({ threadId });
      if (res.ok && this.state.threadId === threadId) {
        this.set({ runs: res.runs });
      }
    } catch (err) {
      this.set({ error: message(err) });
    }
  }

  /** Approves the plan as edited, then starts running it. Returns the problems when the plan needs fixing. */
  async approvePlan(
    runId: string,
    items: PlanItemInput[],
    ctx: Ctx
  ): Promise<PlanError[]> {
    const res = await signedOutAsResult(() =>
      agentRuns().approveRun.mutate({ runId, items })
    );
    if (!res.ok) {
      this.notify(res.message, true);
      return [];
    }
    if (!res.run) {
      return res.errors;
    }
    this.upsertRun(res.run);
    void this.driveRun(runId, ctx);
    return [];
  }

  /**
   * Runs the run's items one per request, in order, until none is left or a turn doesn't finish
   * its item (Stop, a closed tab, a spending cap, an error): then the run waits, and Resume picks
   * up the next pending item.
   */
  async driveRun(runId: string, ctx: Ctx): Promise<void> {
    if (this.state.driving || this.state.streaming) {
      return;
    }
    this.pauseRun = false;
    this.set({ driving: runId });
    try {
      for (let guard = 0; guard < 50; guard++) {
        const run = this.state.runs.find((r) => r.id === runId);
        const item = run && nextItem(run, { threadBusy: false });
        if (!(run && item) || this.pauseRun) {
          break;
        }
        await this.run({ kind: "item", runId, itemId: item.id, ctx });
        const after = this.state.runs
          .find((r) => r.id === runId)
          ?.items.find((i) => i.id === item.id);
        // The item didn't finish (paused, refused or failed to start): stop here.
        if (
          !after ||
          after.status === "pending" ||
          after.status === "running" ||
          this.state.blocked ||
          this.state.busy ||
          this.state.error
        ) {
          break;
        }
      }
    } finally {
      this.pauseRun = false;
      this.set({ driving: null, pausing: false });
      void this.loadRuns();
    }
  }

  /** "Pause after this page": the current item's turn finishes, then the run waits (Resume picks up the next page). */
  pause() {
    this.pauseRun = true;
    this.set({ pausing: true });
  }

  async runAction(
    kind: "discard" | "cancel" | "skip" | "retry",
    runId: string,
    itemId?: string
  ): Promise<void> {
    const runs = agentRuns();
    const call = () => {
      switch (kind) {
        case "discard":
          return runs.discardRun.mutate({ runId });
        case "cancel":
          return runs.cancelRun.mutate({ runId });
        case "skip":
          return runs.skipRunItem.mutate({ runId, itemId: itemId ?? "" });
        case "retry":
          return runs.retryRunItem.mutate({ runId, itemId: itemId ?? "" });
      }
    };
    const res = await signedOutAsResult(call);
    if (!res.ok) {
      return this.notify(res.message, true);
    }
    this.upsertRun(res.run);
  }

  /** Pending run proposals for this page (and opens the one `?review=` names). */
  async loadSiteProposals(): Promise<void> {
    try {
      const res = await agentRuns().siteProposals.query({
        pageId: this.pageId,
      });
      if (!res.ok) {
        return;
      }
      this.set({ siteProposals: res.changesets });
      const want = this.reviewOnLoad;
      if (want && this.state.siteProposals.some((c) => c.id === want)) {
        this.reviewOnLoad = null;
        this.openPreview(want);
      }
    } catch (err) {
      this.set({ error: message(err) });
    }
  }

  /** Opens a run's proposal on the canvas once it's loaded (`?review=` links from the review queue). */
  reviewWhenLoaded(changesetId: string) {
    this.reviewOnLoad = changesetId;
    void this.loadSiteProposals();
  }

  private findChangeset(id: string): { cs: Changeset; run: boolean } | null {
    const own = this.state.changesets.find((c) => c.id === id);
    if (own) {
      return { cs: own, run: false };
    }
    const site = this.state.siteProposals.find((c) => c.id === id);
    return site ? { cs: site, run: true } : null;
  }

  /** Accepts a run's proposal on the server (one commit), after saving; the editor loads the result. */
  private async acceptRunProposal(
    cs: Changeset,
    opts: { groups?: string[]; variant?: number; confirmConflicts?: string[] }
  ): Promise<boolean> {
    this.closePreview();
    this.set({ deciding: cs.id });
    try {
      const res = await this.store.whenSaved(
        (draftVersion) =>
          signedOutAsResult(() =>
            agentRuns().acceptRunChangeset.mutate({
              changesetId: cs.id,
              draftVersion,
              ...(opts.groups && { groups: opts.groups }),
              ...(opts.variant !== undefined && { variant: opts.variant }),
              ...(opts.confirmConflicts?.length && {
                confirmConflicts: opts.confirmConflicts,
              }),
            })
          ),
        { replace: (r) => initOf(r.editor) }
      );
      if (!res) {
        this.notify(
          "The draft couldn't be saved first, so the proposal wasn't applied.",
          true
        );
        return false;
      }
      if (!res.ok) {
        this.notify(`Not applied: ${res.message}`, true);
        return false;
      }
      this.set({
        siteProposals: this.state.siteProposals.filter((c) => c.id !== cs.id),
      });
      this.upsertRunIfOpen(res.run);
      this.notify("Applied. Saved as an agent change of the run in History.");
      return true;
    } finally {
      this.set({ deciding: null });
    }
  }

  private upsertRunIfOpen(run: Run) {
    if (this.state.runs.some((r) => r.id === run.id)) {
      this.upsertRun(run);
    }
  }

  // --- Reviewing ------------------------------------------------------------------------------

  /** Shows an ops changeset on the canvas (read-only) with its groups selected, except those that conflict with later edits. */
  openPreview(id: string) {
    const cs = this.findChangeset(id)?.cs;
    if (!cs?.ops || cs.status !== "pending") {
      return;
    }
    this.store.flushEdits();
    this.store.lock(LOCK);
    const conflicted = new Set(this.conflictsOf(cs).map((c) => c.group));
    this.set({
      preview: {
        id,
        groups: groupsOf(cs.ops).filter((g) => !conflicted.has(g)),
      },
    });
  }

  /** Groups of a pending changeset whose blocks the user changed or deleted since it was proposed. */
  conflictsOf(cs: Changeset) {
    if (!(cs.ops && cs.baseDocJson)) {
      return [];
    }
    return conflicts(
      JSON.parse(cs.baseDocJson) as PageDoc,
      this.store.getSnapshot().doc,
      cs.ops
    );
  }

  closePreview() {
    if (!this.state.preview) {
      return;
    }
    this.store.lock(null);
    this.set({ preview: null });
  }

  toggleGroup(group: string) {
    const p = this.state.preview;
    if (!p) {
      return;
    }
    const groups = p.groups.includes(group)
      ? p.groups.filter((g) => g !== group)
      : [...p.groups, group];
    this.set({ preview: { ...p, groups } });
  }

  /** Applies the selected groups (all when `groups` is omitted) and records the decision. */
  async accept(id: string, groups?: string[]): Promise<void> {
    const found = this.findChangeset(id);
    const cs = found?.cs;
    if (!(found && cs?.ops) || cs.status !== "pending" || this.state.deciding) {
      return;
    }
    const all = groupsOf(cs.ops);
    const chosen = new Set(
      groups ??
        (this.state.preview?.id === id ? this.state.preview.groups : all)
    );
    if (!chosen.size) {
      return this.reject(id);
    }
    if (found.run) {
      // Blocks changed since the proposal that are still chosen were kept knowingly (the canvas marks them, Accept all asks): the server checks against that list.
      const confirmConflicts = this.conflictsOf(cs)
        .map((c) => c.group)
        .filter((g) => chosen.has(g));
      await this.acceptRunProposal(cs, {
        groups: [...chosen],
        confirmConflicts,
      });
      return;
    }
    this.closePreview();
    this.set({ deciding: id });
    try {
      const current = this.store.getSnapshot().doc;
      const base = JSON.parse(cs.baseDocJson ?? "null") as PageDoc | null;
      let staged = current;
      try {
        staged = applyOps(base ?? current, cs.ops).doc;
      } catch {
        // Anchors fall back to the current page.
      }
      const { ops, skipped } = opsToApply(current, cs.ops, chosen, staged);
      if (!ops.length) {
        this.notify(
          "Nothing to apply: the blocks this proposal changes are gone.",
          true
        );
        return;
      }
      const applied = this.store.apply(ops);
      if (!applied.ok) {
        this.notify(
          `The proposal couldn't be applied: ${applied.errors[0]?.message ?? "invalid"}`,
          true
        );
        return;
      }
      const accepted = [...chosen].filter((g) => !skipped.includes(g));
      const rejected = all.filter((g) => !accepted.includes(g));
      const status = rejected.length ? "partial" : "accepted";
      const res = await this.store.whenSaved((draftVersion) =>
        signedOutAsResult(() =>
          agent().decideChangeset.mutate({
            changesetId: id,
            status,
            accepted,
            rejected,
            draftVersion,
          })
        )
      );
      if (!res) {
        return this.notify(
          "Applied, but the draft couldn't be saved yet, so History has no agent entry.",
          true
        );
      }
      if (!res.ok) {
        return this.notify(`Applied, but not recorded: ${res.message}`, true);
      }
      this.updateChangeset(id, {
        status,
        decision: { accepted, rejected, revId: res.revId },
      });
      this.notify(
        skipped.length
          ? `Applied (skipped ${skipped.length} block(s) that changed). Saved as an agent change in History.`
          : "Applied. Saved as an agent change in History."
      );
    } finally {
      this.set({ deciding: null });
    }
  }

  async reject(id: string): Promise<void> {
    const found = this.findChangeset(id);
    const cs = found?.cs;
    if (!cs || cs.status !== "pending" || this.state.deciding) {
      return;
    }
    if (this.state.preview?.id === id) {
      this.closePreview();
    }
    this.set({ deciding: id });
    try {
      if (found.run) {
        const res = await signedOutAsResult(() =>
          agentRuns().rejectRunChangeset.mutate({ changesetId: id })
        );
        if (!res.ok) {
          return this.notify(res.message, true);
        }
        this.set({
          siteProposals: this.state.siteProposals.filter((c) => c.id !== id),
        });
        this.upsertRunIfOpen(res.run);
        return;
      }
      const groups = cs.ops ? groupsOf(cs.ops) : ["seo"];
      const res = await signedOutAsResult(() =>
        agent().decideChangeset.mutate({
          changesetId: id,
          status: "rejected",
          accepted: [],
          rejected: groups,
        })
      );
      if (!res.ok) {
        return this.notify(res.message, true);
      }
      this.updateChangeset(id, {
        status: "rejected",
        decision: { accepted: [], rejected: groups },
      });
    } finally {
      this.set({ deciding: null });
    }
  }

  /** Applies an SEO proposal with the chosen title/description variant. */
  async applySeo(id: string, variant: number): Promise<void> {
    const found = this.findChangeset(id);
    const cs = found?.cs;
    if (!(found && cs?.seo) || cs.status !== "pending" || this.state.deciding) {
      return;
    }
    if (found.run) {
      await this.acceptRunProposal(cs, { variant });
      return;
    }
    this.set({ deciding: id });
    try {
      const applied = this.store.apply([
        seoOpFor(cs.seo, cs.seo.variants[variant]),
      ]);
      if (!applied.ok) {
        return this.notify(
          `The SEO proposal couldn't be applied: ${applied.errors[0]?.message ?? "invalid"}`,
          true
        );
      }
      const res = await this.store.whenSaved((draftVersion) =>
        signedOutAsResult(() =>
          agent().decideChangeset.mutate({
            changesetId: id,
            status: "accepted",
            accepted: ["seo"],
            rejected: [],
            variant,
            draftVersion,
          })
        )
      );
      if (!res) {
        return this.notify(
          "Applied, but the draft couldn't be saved yet.",
          true
        );
      }
      if (!res.ok) {
        return this.notify(`Applied, but not recorded: ${res.message}`, true);
      }
      this.updateChangeset(id, {
        status: "accepted",
        decision: {
          accepted: ["seo"],
          rejected: [],
          variant,
          revId: res.revId,
        },
      });
      this.notify("SEO applied. Saved as an agent change in History.");
    } finally {
      this.set({ deciding: null });
    }
  }

  private updateChangeset(id: string, patch: Partial<Changeset>) {
    this.set({
      changesets: this.state.changesets.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      ),
    });
  }
}

/**
 * Why the agent paused, in a sentence. The same text as services `budgetMessage` (agent/budget.ts),
 * which the browser can't import at runtime (D19).
 */
export function budgetMessage(budget: BudgetStatus): string {
  if (budget.blocked === "thread" && budget.thread) {
    return `This conversation has used ${formatUsd(budget.thread.spentUsd)} of its ${formatUsd(budget.thread.capUsd ?? 0)} limit.`;
  }
  if (budget.blocked === "run" && budget.run) {
    return `This run has used ${formatUsd(budget.run.spentUsd)} of its ${formatUsd(budget.run.capUsd ?? 0)} limit.`;
  }
  if (budget.blocked === "day") {
    return `Today's AI spend is ${formatUsd(budget.day.spentUsd)} of the ${formatUsd(budget.day.capUsd ?? 0)} daily limit.`;
  }
  return "";
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** How long Stop waits for the server's "done" before it stops reading. */
const STOP_WAIT_MS = 8000;

type PauseBody = {
  message?: string;
  code?: string;
  budget?: BudgetStatus;
  full?: ThreadFull;
  modelOff?: ModelOff;
  lockAgeMs?: number;
  takeoverAfterMs?: number;
};

export const AgentViewContext = createContext<AgentView | null>(null);

export function useAgentView(): AgentView {
  const view = useContext(AgentViewContext);
  if (!view) {
    throw new Error("useAgentView must be used inside the page editor");
  }
  return view;
}

export function useAgentState(): AgentState {
  const view = useAgentView();
  return useSyncExternalStore(view.subscribe, view.getState, view.getState);
}

/** The page with the previewed changeset's selected groups applied, or null when no review is open. */
export function useAgentPreviewDoc(current: PageDoc): PageDoc | null {
  const view = useContext(AgentViewContext);
  const state = useSyncExternalStore(
    view?.subscribe ?? noopSubscribe,
    view?.getState ?? nullState,
    view?.getState ?? nullState
  );
  const cs = state?.preview
    ? [...state.changesets, ...state.siteProposals].find(
        (c) => c.id === state.preview!.id
      )
    : undefined;
  const groups = state?.preview?.groups;
  return useMemo(() => {
    if (!(cs?.ops && groups)) {
      return null;
    }
    try {
      return proposedDoc(current, cs.ops, new Set(groups));
    } catch {
      return null;
    }
  }, [cs, groups, current]);
}

const noopSubscribe = () => () => {};
const nullState = () => null;
