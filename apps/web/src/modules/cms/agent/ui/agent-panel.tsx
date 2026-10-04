// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/correctness/useImageSize: media-library images and screenshots of unknown size, sized by their CSS classes.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source UI; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDefaultSwitchClause: switches over closed unions; TypeScript checks exhaustiveness, as in the source.
// biome-ignore-all lint/suspicious/noArrayIndexKey: lists rebuilt per render from fixed arrays with no ids (variants, warnings, errors), never reordered.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.

import type {
  BudgetLine,
  BudgetOverride,
  BudgetStatus,
} from "@repo/cms-core/agent/budget-types";
import {
  conflicts,
  groupsOf,
  proposedDoc,
} from "@repo/cms-core/agent/changeset";
import { formatUsd } from "@repo/cms-core/agent/cost";
import {
  DAY_RAISE_STEP_USD,
  THREAD_RAISE_STEPS_USD,
} from "@repo/cms-core/agent/limits";
import {
  type AgentProviderId,
  modelLabel,
  PROVIDER_LABEL,
} from "@repo/cms-core/agent/models";
import {
  MAX_PLAN_ITEMS,
  PLAN_ACTIONS,
  type PlanAction,
  type PlanError,
  type PlanItemInput,
} from "@repo/cms-core/agent/plan";
import {
  nextItem,
  type Run,
  type RunItem,
  type RunItemStatus,
  runCounts,
} from "@repo/cms-core/agent/run";
import { plainTitle } from "@repo/cms-core/agent/thread-title";
import type {
  Changeset,
  ThreadItem,
  ThreadSummary,
} from "@repo/cms-core/agent/types";
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { type BlockChange, diffDocs } from "@repo/cms-core/editor/diff";
import { FIX_PARAM, takeFixPrompt } from "@repo/cms-core/seo/fix-prompt";
import type { Device, PageDoc } from "@repo/cms-core/types";
import {
  AlertTriangle,
  Bot,
  Check,
  CircleSlash,
  Eye,
  FilePlus2,
  Globe,
  ImagePlus,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  SkipForward,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { FieldList } from "../../editor/history-panel";
import { prepareUpload } from "../../editor/media-library";
import { useEditorState } from "../../editor/use-editor-store";
import { useAgentState, useAgentView } from "./agent-view";

/**
 * The editor's AI tab (docs/cms-plan.md §4.4): pick or start a conversation about this page, chat
 * with the agent (progress notes and tool activity inline), drop or paste images, and review its
 * proposals: content/style changesets on the canvas (ghost overlay, per-block accept), SEO
 * proposals in the SEO tab. Cost per conversation and the spending caps are shown at the top; a
 * reached cap, a busy thread or a full thread pause the chat with a way forward. A new
 * conversation picks its model (Claude or a Workers AI model); the header shows it.
 *
 * "This page | Site" switches to site-wide conversations: the agent submits a plan (an editable
 * checklist to approve), then the run goes page by page with its progress, run total and
 * Pause/Resume here; proposals are reviewed in the review queue (/admin/agent) or on each page's
 * canvas, where this tab lists them under "From site-wide runs".
 *
 * `?agent=site&seoFix=<key>` (/admin/seo "Fix with agent") starts a new site-wide conversation with
 * the findings waiting in sessionStorage under that key.
 */
export function AgentPanel({
  device,
  onOpenSeo,
}: {
  device: Device;
  onOpenSeo: () => void;
}) {
  const view = useAgentView();
  const state = useAgentState();
  const { selectedKey } = useEditorState();
  const listRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef(device);
  deviceRef.current = device;

  useEffect(() => {
    // Links from the review queue: `?review=<changeset>` opens a run's proposal on the canvas;
    // `?agent=site&thread=<id>` opens a site-wide conversation (to resume its run).
    const params = new URLSearchParams(window.location.search);
    const review = params.get("review");
    const thread = params.get("thread");
    // Taken and dropped from the URL before anything else: a reload or Back must not send it again (a paid planning turn).
    const fixKey = params.get(FIX_PARAM);
    const fix = fixKey ? takeFixPrompt(sessionStorage, fixKey) : null;
    if (fixKey) {
      params.delete(FIX_PARAM);
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`
      );
    }
    if (params.get("agent") === "site") {
      void view.setScope("site").then(() =>
        thread
          ? view.openThread(thread)
          : fix
            ? view.send(fix, [], {
                device: deviceRef.current,
                selectedKey: null,
              })
            : undefined
      );
    } else {
      void view.loadThreads();
    }
    if (review) {
      view.reviewWhenLoaded(review);
    } else {
      void view.loadSiteProposals();
    }
    void view.loadModels();
  }, [view]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.items.length, state.changesets.length, state.items.at(-1)]);

  const thread = state.threads.find((t) => t.id === state.threadId);
  const site = state.scope === "site";
  // During (and after) a run item the cost line counts that page's own thread, not the site conversation.
  const itemTurn =
    site &&
    !!state.budget?.threadId &&
    state.budget.threadId !== state.threadId;
  // A site-wide conversation's proposals are for other pages: they are reviewed in the queue or on their own page.
  const pending = site
    ? []
    : state.changesets.filter((c) => c.status === "pending");
  const fromRuns = site
    ? []
    : state.siteProposals.filter((c) => c.status === "pending");

  return (
    <div className="flex h-full flex-col text-sm" data-testid="agent-panel">
      <ScopeToggle />
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 p-2">
        <select
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
          value={state.threadId ?? ""}
          disabled={state.streaming}
          onChange={(e) => void view.openThread(e.target.value || null)}
          data-testid="agent-thread-select"
          aria-label="Conversation"
        >
          <option value="">
            {site ? "New site-wide conversation" : "New conversation"}
          </option>
          {state.threads.map((t) => (
            <option key={t.id} value={t.id}>
              {plainTitle(t.title, 48)} · {formatUsd(t.costUsd)} ·{" "}
              {PROVIDER_LABEL[t.provider]}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="secondary"
          disabled={state.streaming || !state.threadId}
          onClick={() => void view.openThread(null)}
          title="New conversation"
          data-testid="agent-new-thread"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {!state.threadId && <ModelPicker />}
      <div
        className="shrink-0 space-y-0.5 border-b border-neutral-800 px-3 py-1 text-xs text-neutral-400"
        data-testid="agent-cost"
      >
        {thread && <ModelBadge thread={thread} />}
        <div className="flex items-center justify-between">
          <span>
            {thread
              ? itemTurn
                ? "This page of the run"
                : site
                  ? "This site-wide conversation"
                  : "This conversation"
              : "Not started"}
          </span>
          <span title={state.usage ? usageTitle(state.usage) : undefined}>
            {formatUsd(state.threadCostUsd)}
            {!!state.budget?.thread && <BudgetCap line={state.budget.thread} />}
            {state.usage && state.usage.cacheReadTokens > 0 && (
              <span className="ml-2 text-neutral-500">
                cache {Math.round(state.usage.cacheReadTokens / 1000)}K
              </span>
            )}
          </span>
        </div>
        {!!state.budget?.run && (
          <div
            className="flex items-center justify-between text-neutral-500"
            data-testid="agent-budget-run"
          >
            <span>This run</span>
            <span>
              {formatUsd(state.budget.run.spentUsd)}
              <BudgetCap line={state.budget.run} />
            </span>
          </div>
        )}
        {!!state.budget && (
          <div
            className="flex items-center justify-between text-neutral-500"
            data-testid="agent-budget-day"
          >
            <span>Today</span>
            <span>
              {formatUsd(state.budget.day.spentUsd)}
              <BudgetCap line={state.budget.day} />
            </span>
          </div>
        )}
        {!!state.budget && <Overrides budget={state.budget} />}
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
        data-testid="agent-messages"
      >
        {!(state.items.length || state.loading) &&
          (site ? <SiteHint /> : <EmptyHint />)}
        {!!state.loading && <p className="text-neutral-500">Loading…</p>}
        {state.items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        {!!state.streaming && (
          <p
            className="flex items-center gap-2 text-xs text-neutral-500"
            data-testid="agent-working"
          >
            <Loader2 className="h-3 w-3 animate-spin" /> Working…
          </p>
        )}
        {site &&
          state.runs
            .filter((r) => r.status !== "superseded")
            .map((r) =>
              r.status === "proposed" ? (
                <PlanCard key={r.id} run={r} device={device} />
              ) : (
                <RunCard key={r.id} run={r} device={device} />
              )
            )}
        {!!state.error && (
          <p className="text-xs text-red-400" role="alert">
            {state.error}
          </p>
        )}
        {!!state.blocked && <BudgetPause />}
        {!!state.busy && <BusyPause />}
        {!!state.full && <FullPause />}
        {!!state.modelOff && <ModelOffPause />}
        {state.changesets
          .filter((c) => c.status !== "pending" && c.status !== "superseded")
          .map((c) => (
            <p
              key={c.id}
              className="text-xs text-neutral-500"
              data-testid="agent-decided"
            >
              {c.kind === "seo" ? "SEO proposal" : "Proposal"} “{c.summary}”:{" "}
              {c.status}
            </p>
          ))}
      </div>

      {pending.length + fromRuns.length > 0 && (
        <div
          className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-t border-neutral-800 bg-neutral-950/60 p-2"
          data-testid="agent-proposals"
        >
          {pending.map((c) =>
            c.kind === "seo" ? (
              <SeoCard key={c.id} cs={c} onOpenSeo={onOpenSeo} />
            ) : (
              <OpsCard key={c.id} cs={c} />
            )
          )}
          {fromRuns.length > 0 && (
            <p
              className="flex items-center gap-1 pt-1 text-[11px] uppercase tracking-wide text-neutral-500"
              data-testid="agent-run-proposals"
            >
              <Globe className="h-3 w-3" /> From site-wide runs
            </p>
          )}
          {fromRuns.map((c) =>
            c.kind === "seo" ? (
              <SeoCard key={c.id} cs={c} onOpenSeo={onOpenSeo} />
            ) : (
              <OpsCard key={c.id} cs={c} />
            )
          )}
        </div>
      )}

      <Composer device={device} selectedKey={selectedKey} />
    </div>
  );
}

const PROVIDER_STYLE: Record<AgentProviderId, string> = {
  anthropic: "bg-violet-900/60 text-violet-200",
  "workers-ai": "bg-amber-900/60 text-amber-200",
};

/** The open conversation's model and provider. */
function ModelBadge({ thread }: { thread: ThreadSummary }) {
  const { models } = useAgentState();
  return (
    <div
      className="flex items-center gap-1.5 pt-0.5"
      title={thread.model}
      data-testid="agent-model-badge"
      data-provider={thread.provider}
    >
      <span className="text-neutral-200">
        {modelLabel(models, { provider: thread.provider, id: thread.model })}
      </span>
      <span
        className={`rounded px-1.5 text-[10px] ${PROVIDER_STYLE[thread.provider]}`}
      >
        {PROVIDER_LABEL[thread.provider]}
      </span>
    </div>
  );
}

/** The model a new conversation starts on (it keeps it). Models that can't run here are listed with the reason. */
function ModelPicker() {
  const view = useAgentView();
  const state = useAgentState();
  const enabled = state.models.filter((m) => m.enabled);
  if (!enabled.length) {
    return null;
  }
  const unavailable = enabled.filter((m) => !m.available);
  const key = (m: { provider: string; id: string }) => `${m.provider}|${m.id}`;
  return (
    <div
      className="shrink-0 border-b border-neutral-800 px-2 py-1.5 text-xs"
      data-testid="agent-model-picker"
    >
      <div className="flex items-center gap-2">
        <label htmlFor="agent-model" className="text-neutral-400">
          Model
        </label>
        <select
          id="agent-model"
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          value={key(state.newModel)}
          disabled={state.streaming}
          onChange={(e) => {
            const m = enabled.find((x) => key(x) === e.target.value);
            if (m) {
              view.setNewModel({ provider: m.provider, id: m.id });
            }
          }}
          data-testid="agent-model-select"
        >
          {enabled.map((m) => (
            <option
              key={key(m)}
              value={key(m)}
              disabled={!m.available}
              title={m.reason}
            >
              {m.label} · {PROVIDER_LABEL[m.provider]}
              {m.available ? "" : " (unavailable)"}
            </option>
          ))}
        </select>
      </div>
      {unavailable.map((m) => (
        <p
          key={key(m)}
          className="mt-1 text-[11px] text-amber-300/90"
          data-testid="agent-model-unavailable"
        >
          {m.label}: {m.reason}
        </p>
      ))}
    </div>
  );
}

/** " of $3.00 · $1.20 left", or " · no limit". */
function BudgetCap({ line }: { line: BudgetLine }) {
  if (line.capUsd === null) {
    return <span className="ml-1 text-neutral-500">· no limit</span>;
  }
  return (
    <span
      className={`ml-1 ${line.remainingUsd === 0 ? "text-amber-300" : "text-neutral-500"}`}
      data-testid="agent-budget-cap"
    >
      of {formatUsd(line.capUsd)} · {formatUsd(line.remainingUsd ?? 0)} left
    </span>
  );
}

/** Raised limits on this thread and today: amount, who, when. */
function Overrides({ budget }: { budget: BudgetStatus }) {
  const all: BudgetOverride[] = [
    ...(budget.thread?.overrides ?? []),
    ...(budget.run?.overrides ?? []),
    ...budget.day.overrides,
  ];
  if (!all.length) {
    return null;
  }
  return (
    <ul
      className="text-[11px] text-neutral-500"
      data-testid="agent-budget-overrides"
    >
      {all.map((o) => (
        <li key={o.id}>
          {o.scope === "thread"
            ? "Conversation"
            : o.scope === "run"
              ? "Run"
              : "Today"}
          : {o.amountUsd === null ? "no limit" : `+${formatUsd(o.amountUsd)}`}{" "}
          by {o.createdBy ?? "an admin"},{" "}
          {new Date(o.createdAt).toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </li>
      ))}
    </ul>
  );
}

/** A cap was reached: raise it (and carry on) or stop here. */
function BudgetPause() {
  const view = useAgentView();
  const state = useAgentState();
  const blocked = state.blocked!;
  const [busy, setBusy] = useState(false);
  const raise = (scope: "thread" | "run" | "day", amount: number | null) => {
    setBusy(true);
    void view.raiseBudget(scope, amount).finally(() => setBusy(false));
  };
  const capped = blocked.budget.blocked;
  const steps = capped === "run" ? "run" : "thread";
  return (
    <div
      className="rounded border border-amber-700/60 bg-amber-950/30 p-2 text-xs text-amber-100"
      role="alert"
      data-testid="agent-budget-pause"
    >
      <p className="font-medium">{blocked.message}</p>
      <p className="mt-0.5 text-amber-200/80">
        {blocked.retry
          ? "Raise the limit to carry on where it stopped."
          : "Raise the limit to keep using the agent."}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {capped === "thread" || capped === "run" ? (
          <>
            {THREAD_RAISE_STEPS_USD.map((n) => (
              <Button
                key={n}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => raise(steps, n)}
                data-testid={`agent-raise-${steps}-${n}`}
              >
                {n === THREAD_RAISE_STEPS_USD[0]
                  ? `Raise this ${steps === "run" ? "run" : "thread"}'s limit by ${formatUsd(n)}`
                  : `+${formatUsd(n)}`}
              </Button>
            ))}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => raise(steps, null)}
              data-testid={`agent-raise-${steps}-unlimited`}
            >
              No limit for this {steps === "run" ? "run" : "thread"}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => raise("day", DAY_RAISE_STEP_USD)}
              data-testid="agent-raise-day"
            >
              +{formatUsd(DAY_RAISE_STEP_USD)} today
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => raise("day", null)}
              data-testid="agent-raise-day-unlimited"
            >
              No daily limit today
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Another tab is running a turn here. */
function BusyPause() {
  const view = useAgentView();
  const busy = useAgentState().busy!;
  const canTakeOver = busy.lockAgeMs >= busy.takeoverAfterMs;
  return (
    <div
      className="rounded border border-neutral-700 bg-neutral-900 p-2 text-xs text-neutral-200"
      role="alert"
      data-testid="agent-busy"
    >
      <p className="font-medium">{busy.message}</p>
      <p className="mt-0.5 text-neutral-400">
        {canTakeOver
          ? `Its turn started ${Math.round(busy.lockAgeMs / 60_000)} min ago and may have been left behind.`
          : `Wait for it to finish (a turn left behind by a closed tab frees itself within a minute), or take over once it's ${Math.round(busy.takeoverAfterMs / 60_000)} minutes old.`}
      </p>
      {canTakeOver && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => void view.takeOver()}
          data-testid="agent-take-over"
        >
          Take over
        </Button>
      )}
    </div>
  );
}

/** The thread takes no new messages: start a new one carrying a summary. */
function FullPause() {
  const view = useAgentView();
  const full = useAgentState().full!;
  return (
    <div
      className="rounded border border-neutral-700 bg-neutral-900 p-2 text-xs text-neutral-200"
      role="alert"
      data-testid="agent-thread-full"
    >
      <p>{full.message}</p>
      <Button
        size="sm"
        className="mt-2"
        onClick={() => view.startNewThread(full.summary)}
        data-testid="agent-start-new-thread"
      >
        <Plus className="h-3.5 w-3.5" /> Start a new thread
      </Button>
    </div>
  );
}

/** The thread's model was turned off or removed: start a new thread on another model, carrying a summary. */
function ModelOffPause() {
  const view = useAgentView();
  const off = useAgentState().modelOff!;
  return (
    <div
      className="rounded border border-neutral-700 bg-neutral-900 p-2 text-xs text-neutral-200"
      role="alert"
      data-testid="agent-model-off"
    >
      <p>{off.message}</p>
      {!!off.next && (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => view.startNewThreadWith(off.next!, off.summary)}
          data-testid="agent-model-off-new-thread"
        >
          <Plus className="h-3.5 w-3.5" /> Start a new thread with{" "}
          {off.next.label}
        </Button>
      )}
    </div>
  );
}

function usageTitle(u: NonNullable<ReturnType<typeof useAgentState>["usage"]>) {
  return `Input ${u.inputTokens} · cache read ${u.cacheReadTokens} · cache write ${u.cacheWriteTokens} · output ${u.outputTokens} tokens`;
}

function EmptyHint() {
  return (
    <div
      className="space-y-2 text-xs text-neutral-400"
      data-testid="agent-empty"
    >
      <p className="flex items-center gap-2 text-neutral-300">
        <Bot className="h-4 w-4" /> Ask the agent to change this page.
      </p>
      <p>
        It reads the page, proposes changes for you to review on the canvas, and
        never publishes. For example:
      </p>
      <ul className="list-disc space-y-1 pl-4">
        <li>Rewrite the hero for a new audience</li>
        <li>Make the CTA stand out more on mobile</li>
        <li>Do the SEO for this page</li>
      </ul>
      <p className="text-neutral-500" data-testid="agent-close-tab-hint">
        Closing the tab lets the agent finish the model call it's on, for about
        30 seconds. A slower call (Workers AI models can take longer) is cut off
        and not kept, but what it cost so far still counts.
      </p>
    </div>
  );
}

function Item({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div
          className="ml-6 rounded bg-neutral-800 px-3 py-2 text-neutral-100"
          data-testid="agent-user-message"
        >
          <p className="whitespace-pre-wrap">{item.text}</p>
          {item.images.length > 0 && (
            <div className="mt-2 flex gap-1">
              {item.images.map((src) => (
                <img
                  key={src}
                  src={src}
                  alt=""
                  className="h-12 w-12 rounded object-cover"
                />
              ))}
            </div>
          )}
        </div>
      );
    case "text":
      return (
        <div className="mr-2 text-neutral-100" data-testid="agent-text">
          {!!item.fallback && (
            <span
              className="mb-1 inline-block rounded bg-amber-600/30 px-1.5 text-[10px] text-amber-200"
              data-testid="agent-fallback-badge"
              title={item.model}
            >
              Answered by {item.model ?? "a fallback model"}
            </span>
          )}
          <p className="whitespace-pre-wrap leading-relaxed">
            {withBold(item.text)}
          </p>
          {!!item.partial && (
            <span
              className="text-[10px] text-amber-300"
              data-testid="agent-partial"
            >
              (cut off)
            </span>
          )}
        </div>
      );
    case "progress":
      if (item.reasoning) {
        return (
          <details
            className="border-l-2 border-neutral-800 pl-2 text-xs text-neutral-500"
            data-testid="agent-reasoning"
          >
            <summary className="cursor-pointer select-none">Reasoning</summary>
            <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
          </details>
        );
      }
      return (
        <p
          className="border-l-2 border-neutral-700 pl-2 text-xs italic text-neutral-400"
          data-testid="agent-progress"
        >
          {item.text}
        </p>
      );
    case "tool":
      return (
        <div className="text-xs" data-testid="agent-tool">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
              item.interrupted
                ? "border-neutral-700 text-neutral-500"
                : item.ok === null
                  ? "border-neutral-700 text-neutral-400"
                  : item.ok
                    ? "border-emerald-800 text-emerald-300"
                    : "border-amber-700 text-amber-300"
            }`}
            title={item.summary}
            data-interrupted={item.interrupted || undefined}
          >
            {item.interrupted ? (
              <CircleSlash className="h-3 w-3" />
            ) : item.ok === null ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : item.ok ? (
              <Check className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            {item.label}
            {!!item.summary && (
              <span className="text-neutral-500">
                · {item.summary.slice(0, 80)}
              </span>
            )}
          </span>
          {!!item.image && (
            <img
              src={item.image}
              alt=""
              className="mt-1 max-h-40 rounded border border-neutral-800"
              data-testid="agent-tool-image"
            />
          )}
        </div>
      );
    case "refusal":
      return (
        <p
          className="flex items-center gap-1 text-xs text-amber-300"
          data-testid="agent-refusal"
        >
          <CircleSlash className="h-3 w-3" /> The model declined this request
          {item.category ? ` (${item.category})` : ""}.
        </p>
      );
    case "created":
      return (
        <p
          className="flex items-center gap-1 text-xs text-emerald-300"
          data-testid="agent-created"
        >
          <FilePlus2 className="h-3.5 w-3.5" /> Draft created:{" "}
          <a
            href={item.page.editorUrl}
            className="underline hover:text-white"
            data-testid="agent-created-link"
          >
            {item.page.title || `/${item.page.slug}`}
          </a>
          <span className="text-neutral-500">
            ({item.page.kind}, not published)
          </span>
        </p>
      );
    case "notice":
      return (
        <p className="text-xs text-neutral-400" data-testid="agent-notice">
          {item.text}
        </p>
      );
  }
}

/** The model's replies are plain text apart from the odd `**bold**`, which is shown as bold. */
function withBold(text: string) {
  return text
    .split(/(\*\*[^*\n]+\*\*)/g)
    .map((part, i) =>
      /^\*\*[^*\n]+\*\*$/.test(part) ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    );
}

// ---------------------------------------------------------------------------------------------
// Proposals

const STATUS_STYLE: Record<BlockChange["status"], string> = {
  added: "bg-emerald-700/40 text-emerald-200",
  changed: "bg-sky-700/40 text-sky-200",
  removed: "bg-red-800/40 text-red-200",
  moved: "bg-neutral-700 text-neutral-200",
};

/** A pending content/style changeset: per-block rows with their field diff and conflicts. */
function OpsCard({ cs }: { cs: Changeset }) {
  const view = useAgentView();
  const state = useAgentState();
  const { doc } = useEditorState();
  const previewing = state.preview?.id === cs.id;
  const fromRun = state.siteProposals.some((c) => c.id === cs.id);
  const ops = cs.ops ?? [];
  const groups = useMemo(() => groupsOf(ops), [ops]);
  const base = useMemo(
    () => (cs.baseDocJson ? (JSON.parse(cs.baseDocJson) as PageDoc) : doc),
    [cs.baseDocJson, doc]
  );
  const proposal = useMemo(() => proposedDoc(doc, ops), [doc, ops]);
  const diff = useMemo(() => diffDocs(doc, proposal), [doc, proposal]);
  const conflicted = useMemo(
    () => new Map(conflicts(base, doc, ops).map((c) => [c.group, c.reason])),
    [base, doc, ops]
  );
  const busy = state.deciding === cs.id;
  const selected = previewing ? state.preview!.groups : groups;
  const [confirmAll, setConfirmAll] = useState(false);
  const groupLabel = (g: string) => {
    const change = diff.blocks.find((b) => b.key === g);
    return g === "post"
      ? "Post details"
      : g === "seo"
        ? "SEO"
        : (getBlockDef(change?.type ?? "")?.label ?? change?.type ?? g);
  };
  const acceptAll = () =>
    conflicted.size ? setConfirmAll(true) : void view.accept(cs.id, groups);

  return (
    <div
      className="rounded border border-sky-800/60 bg-neutral-900 p-2"
      data-testid="agent-ops-card"
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <p className="font-medium text-neutral-100">{cs.summary}</p>
        <span className="shrink-0 rounded bg-sky-800/50 px-1.5 text-[10px] uppercase text-sky-200">
          {fromRun ? "Run proposal" : "Proposal"}
        </span>
      </div>
      {cs.warnings?.map((w, i) => (
        <p
          key={i}
          className="flex items-center gap-1 text-xs text-amber-300"
          data-testid="agent-warning"
        >
          <AlertTriangle className="h-3 w-3" /> {w.message}
        </p>
      ))}
      <ul className="mt-1 space-y-1">
        {groups.map((g) => {
          const change = diff.blocks.find((b) => b.key === g);
          const label =
            g === "post"
              ? "Post details"
              : g === "seo"
                ? "SEO"
                : (getBlockDef(change?.type ?? "")?.label ?? change?.type ?? g);
          const conflict = conflicted.get(g);
          return (
            <li
              key={g}
              className="rounded bg-neutral-950/60 p-1.5"
              data-testid="agent-group"
              data-group={g}
            >
              <div className="flex items-center gap-2">
                {previewing && (
                  <input
                    type="checkbox"
                    checked={selected.includes(g)}
                    onChange={() => view.toggleGroup(g)}
                    aria-label={`Accept ${label}`}
                    data-testid="agent-group-toggle"
                  />
                )}
                <span className="text-xs font-medium">{label}</span>
                {change && (
                  <span
                    className={`rounded px-1 text-[10px] ${STATUS_STYLE[change.status]}`}
                  >
                    {change.status === "changed" &&
                    change.fields.some((f) => f.path.startsWith("style")) &&
                    !change.fields.some((f) => !f.path.startsWith("style"))
                      ? "style"
                      : change.status}
                  </span>
                )}
                {conflict && (
                  <span
                    className="rounded bg-red-800/50 px-1 text-[10px] text-red-200"
                    data-testid="agent-conflict"
                    title="You edited this block after the proposal was made"
                  >
                    {conflict === "deleted"
                      ? "you deleted it"
                      : "you changed it"}
                  </span>
                )}
              </div>
              {change?.status === "changed" && (
                <FieldList fields={change.fields} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-1">
        {previewing ? (
          <>
            <Button
              size="sm"
              onClick={() => void view.accept(cs.id)}
              disabled={busy || !selected.length}
              data-testid="agent-accept-selected"
            >
              <Check className="h-3.5 w-3.5" /> Accept{" "}
              {selected.length === groups.length
                ? "all"
                : `${selected.length} of ${groups.length}`}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => view.closePreview()}
              data-testid="agent-close-review"
            >
              Close review
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => view.openPreview(cs.id)}
              disabled={busy}
              data-testid="agent-review"
            >
              <Eye className="h-3.5 w-3.5" /> Review on canvas
            </Button>
            <Button
              size="sm"
              onClick={acceptAll}
              disabled={busy}
              data-testid="agent-accept-all"
            >
              <Check className="h-3.5 w-3.5" /> Accept all
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.reject(cs.id)}
          disabled={busy}
          data-testid="agent-reject"
        >
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
      </div>
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent
          className="border-neutral-700 bg-neutral-900 text-neutral-100"
          data-testid="agent-conflict-confirm"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite your edits?</AlertDialogTitle>
            <AlertDialogDescription className="text-neutral-400">
              You changed these blocks after the agent made this proposal.
              Accepting all replaces your edits with the agent's version:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul
            className="list-disc space-y-0.5 pl-5 text-sm"
            data-testid="agent-conflict-list"
          >
            {[...conflicted].map(([g, reason]) => (
              <li key={g}>
                {groupLabel(g)}{" "}
                <span className="text-neutral-400">
                  ({reason === "deleted" ? "you deleted it" : "you changed it"})
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700">
              Cancel
            </AlertDialogCancel>
            {groups.length > conflicted.size && (
              <AlertDialogAction
                onClick={() =>
                  void view.accept(
                    cs.id,
                    groups.filter((g) => !conflicted.has(g))
                  )
                }
                className="bg-neutral-700 hover:bg-neutral-600"
                data-testid="agent-accept-unconflicted"
              >
                Accept the others
              </AlertDialogAction>
            )}
            <AlertDialogAction
              onClick={() => void view.accept(cs.id, groups)}
              className="bg-red-700 hover:bg-red-600"
              data-testid="agent-accept-all-confirm"
            >
              Accept all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SeoCard({ cs, onOpenSeo }: { cs: Changeset; onOpenSeo: () => void }) {
  const view = useAgentView();
  const state = useAgentState();
  return (
    <div
      className="rounded border border-violet-800/60 bg-neutral-900 p-2"
      data-testid="agent-seo-card"
    >
      <p className="font-medium text-neutral-100">{cs.summary}</p>
      <p className="mt-1 text-xs text-neutral-400">
        {cs.seo?.variants.length ?? 0} title/description options, social copy
        {cs.seo?.seo.social?.image ? " and a share image" : ""}.
      </p>
      <div className="mt-2 flex gap-1">
        <Button size="sm" onClick={onOpenSeo} data-testid="agent-open-seo">
          Review in SEO tab
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.reject(cs.id)}
          disabled={state.deciding === cs.id}
        >
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Composer

type Attachment = {
  key: string;
  name: string;
  id?: string;
  url?: string;
  error?: string;
};

function Composer({
  device,
  selectedKey,
}: {
  device: Device;
  selectedKey: string | null;
}) {
  const view = useAgentView();
  const state = useAgentState();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const uploading = files.some((f) => !(f.id || f.error));

  // A summary handed over by "Start a new thread".
  useEffect(() => {
    if (state.draft === null) {
      return;
    }
    setText(state.draft);
    view.takeDraft();
  }, [state.draft, view]);

  const addFiles = (list: File[]) => {
    for (const file of list
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, 4)) {
      const key = nanoid();
      setFiles((fs) => [...fs, { key, name: file.name || "pasted image" }]);
      void upload(file).then(
        (m) =>
          setFiles((fs) =>
            fs.map((f) => (f.key === key ? { ...f, id: m.id, url: m.url } : f))
          ),
        (err: unknown) =>
          setFiles((fs) =>
            fs.map((f) =>
              f.key === key
                ? {
                    ...f,
                    error: err instanceof Error ? err.message : String(err),
                  }
                : f
            )
          )
      );
    }
  };

  const send = () => {
    const ready = files.filter(
      (f): f is Attachment & { id: string; url: string } => !!f.id && !!f.url
    );
    if (!text.trim() || uploading || state.streaming || state.driving) {
      return;
    }
    void view.send(text.trim(), ready, { device, selectedKey });
    setText("");
    setFiles([]);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone for image files; the textarea and buttons inside are the interactive elements, and files can also be picked with the attach button.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: as above.
    <div
      className={`shrink-0 border-t border-neutral-800 p-2 ${dragging ? "bg-accent/10" : ""}`}
      onDragOver={(e: DragEvent) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
      data-testid="agent-composer"
    >
      {files.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {files.map((f) => (
            <span
              key={f.key}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${f.error ? "border-red-700 text-red-300" : "border-neutral-700 text-neutral-300"}`}
              title={f.error}
              data-testid="agent-attachment"
            >
              {f.url ? (
                <img
                  src={f.url}
                  alt=""
                  className="h-5 w-5 rounded object-cover"
                />
              ) : f.error ? (
                <AlertTriangle className="h-3 w-3" />
              ) : (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {f.name.slice(0, 20)}
              <button
                type="button"
                aria-label="Remove image"
                onClick={() =>
                  setFiles((fs) => fs.filter((x) => x.key !== f.key))
                }
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Textarea
        value={text}
        rows={3}
        placeholder={
          state.scope === "site"
            ? "Describe a change across pages; the agent plans it first…"
            : selectedKey
              ? "Ask about the selected block or the page…"
              : "Ask the agent to change this page…"
        }
        onChange={(e) => setText(e.target.value)}
        onPaste={(e: ClipboardEvent) => {
          const images = [...e.clipboardData.files].filter((f) =>
            f.type.startsWith("image/")
          );
          if (images.length) {
            e.preventDefault();
            addFiles(images);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className="resize-none border-neutral-700 bg-neutral-950 text-sm"
        data-testid="agent-input"
        disabled={state.streaming || !!state.driving}
      />
      <div className="mt-1 flex items-center justify-between">
        <label
          className="flex cursor-pointer items-center gap-1 text-xs text-neutral-400 hover:text-white"
          title="Attach images (or paste/drop them)"
        >
          <ImagePlus className="h-4 w-4" /> Image
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => addFiles([...(e.target.files ?? [])])}
          />
        </label>
        {state.streaming ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => view.stop()}
            data-testid="agent-stop"
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={send}
            disabled={!text.trim() || uploading}
            data-testid="agent-send"
          >
            <Send className="h-3.5 w-3.5" /> Send
          </Button>
        )}
      </div>
    </div>
  );
}

async function upload(file: File): Promise<{ id: string; url: string }> {
  const blob = await prepareUpload(file);
  const form = new FormData();
  form.append("file", blob, file.name || "image");
  const res = await fetch("/admin/api/media", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    url?: string;
    message?: string;
  } | null;
  if (!(res.ok && body?.id && body.url)) {
    throw new Error(body?.message ?? `Upload failed (${res.status}).`);
  }
  return { id: body.id, url: body.url };
}

// ---------------------------------------------------------------------------------------------
// Site-wide conversations: scope, plan checklist, run progress

/** This page's conversations or the site-wide ones. */
function ScopeToggle() {
  const view = useAgentView();
  const state = useAgentState();
  const locked = state.streaming || !!state.driving;
  const tab = (
    scope: "page" | "site",
    label: string,
    icon: React.ReactNode
  ) => (
    <button
      type="button"
      disabled={locked}
      onClick={() => void view.setScope(scope)}
      className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs ${state.scope === scope ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"} disabled:opacity-50`}
      aria-pressed={state.scope === scope}
      data-testid={`agent-scope-${scope}`}
    >
      {icon} {label}
    </button>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a bar of two toggle buttons, not a form section; a fieldset would add form semantics and a legend, as in the source.
    <div
      className="flex shrink-0 gap-1 border-b border-neutral-800 p-1.5"
      role="group"
      aria-label="Scope"
    >
      {tab("page", "This page", <Bot className="h-3.5 w-3.5" />)}
      {tab("site", "Site", <Globe className="h-3.5 w-3.5" />)}
    </div>
  );
}

function SiteHint() {
  return (
    <div
      className="space-y-2 text-xs text-neutral-400"
      data-testid="agent-site-empty"
    >
      <p className="flex items-center gap-2 text-neutral-300">
        <Globe className="h-4 w-4" /> Work across several pages.
      </p>
      <p>
        The agent first proposes a plan, one item per page, which you can edit
        and approve. Then it works through the pages one at a time; every change
        waits for your review and nothing is published. For example:
      </p>
      <ul className="list-disc space-y-1 pl-4">
        <li>Create two new service pages modelled on an existing page</li>
        <li>Fix the striking-distance pages</li>
      </ul>
      <p className="text-neutral-500">
        Closing the tab pauses a run after the page it's on; open this
        conversation again to resume.
      </p>
    </div>
  );
}

type DraftItem = PlanItemInput & { key: string; include: boolean };

const ACTION_LABEL: Record<PlanAction, string> = {
  edit: "Edit",
  seo: "SEO",
  create: "Create",
  duplicate: "Duplicate",
};

/** The agent's plan as an editable checklist: untick or edit items, add a page, then approve. */
function PlanCard({ run, device }: { run: Run; device: Device }) {
  const view = useAgentView();
  const state = useAgentState();
  const [items, setItems] = useState<DraftItem[]>(() =>
    run.items.map((i) => ({
      key: i.id,
      include: true,
      slug: i.slug,
      action: i.action,
      intent: i.intent,
      ...(i.from !== undefined && { from: i.from }),
    }))
  );
  const [errors, setErrors] = useState<
    { key: string | null; message: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const included = items.filter((i) => i.include);
  const patch = (key: string, p: Partial<DraftItem>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const approve = () => {
    setBusy(true);
    const payload = included.map(({ slug, action, intent, from }) => ({
      slug,
      action,
      intent,
      ...(action === "duplicate" && from !== undefined && { from }),
    }));
    void view
      .approvePlan(run.id, payload, { device, selectedKey: null })
      .then((errs: PlanError[]) => {
        setErrors(
          errs.map((e) => {
            const idx = /^items\[(\d+)\]/.exec(e.path);
            return {
              key: idx ? (included[Number(idx[1])]?.key ?? null) : null,
              message: e.message,
            };
          })
        );
      })
      .finally(() => setBusy(false));
  };
  const errorsOf = (key: string | null) => errors.filter((e) => e.key === key);
  return (
    <div
      className="space-y-2 rounded border border-emerald-800/60 bg-neutral-900 p-2"
      data-testid="agent-plan"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 font-medium text-neutral-100">
          <ListChecks className="h-4 w-4 text-emerald-300" /> Plan:{" "}
          {run.summary}
        </p>
        <span
          className="shrink-0 text-[11px] text-neutral-500"
          title="Spend of the planning turn"
        >
          {formatUsd(run.costUsd)}
        </span>
      </div>
      <p className="text-xs text-neutral-400">
        Untick pages to leave out, edit what each item should do, or add a page.
        Nothing changes until you approve.
      </p>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li
            key={i.key}
            className={`space-y-1 rounded border p-1.5 ${i.include ? "border-neutral-700 bg-neutral-950/60" : "border-neutral-800 opacity-50"}`}
            data-testid="agent-plan-item"
          >
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={i.include}
                onChange={(e) => patch(i.key, { include: e.target.checked })}
                aria-label={`Include /${i.slug}`}
                data-testid="agent-plan-include"
              />
              <select
                value={i.action}
                onChange={(e) =>
                  patch(i.key, { action: e.target.value as PlanAction })
                }
                className="rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px]"
                aria-label="Action"
              >
                {PLAN_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </option>
                ))}
              </select>
              <span className="text-neutral-500">/</span>
              <input
                value={i.slug}
                onChange={(e) => patch(i.key, { slug: e.target.value })}
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono text-[11px]"
                aria-label="Slug"
                data-testid="agent-plan-slug"
              />
            </div>
            {i.action === "duplicate" && (
              <label className="flex items-center gap-1 pl-5 text-[11px] text-neutral-400">
                copy of /
                <input
                  value={i.from ?? ""}
                  onChange={(e) => patch(i.key, { from: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono"
                  aria-label="Copy from"
                />
              </label>
            )}
            <Textarea
              value={i.intent}
              rows={2}
              onChange={(e) => patch(i.key, { intent: e.target.value })}
              className="min-h-0 resize-y border-neutral-700 bg-neutral-950 text-xs"
              aria-label="What to do"
              data-testid="agent-plan-intent"
            />
            {errorsOf(i.key).map((e, n) => (
              <p
                key={n}
                className="text-[11px] text-red-400"
                data-testid="agent-plan-error"
              >
                {e.message}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {errorsOf(null).map((e, n) => (
        <p
          key={n}
          className="text-[11px] text-red-400"
          data-testid="agent-plan-error"
        >
          {e.message}
        </p>
      ))}
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || items.length >= MAX_PLAN_ITEMS}
          onClick={() =>
            setItems((list) => [
              ...list,
              {
                key: nanoid(),
                include: true,
                slug: "",
                action: "edit",
                intent: "",
              },
            ])
          }
          data-testid="agent-plan-add"
        >
          <Plus className="h-3.5 w-3.5" /> Add a page
        </Button>
        <Button
          size="sm"
          disabled={
            busy || !included.length || state.streaming || !!state.driving
          }
          onClick={approve}
          data-testid="agent-plan-approve"
        >
          <Check className="h-3.5 w-3.5" /> Approve and run {included.length}{" "}
          page{included.length === 1 ? "" : "s"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void view.runAction("discard", run.id)}
          data-testid="agent-plan-discard"
        >
          <Trash2 className="h-3.5 w-3.5" /> Discard
        </Button>
      </div>
    </div>
  );
}

const ITEM_STYLE: Record<RunItemStatus, string> = {
  pending: "bg-neutral-800 text-neutral-300",
  running: "bg-sky-800/60 text-sky-100",
  proposed: "bg-violet-800/60 text-violet-100",
  accepted: "bg-emerald-800/60 text-emerald-100",
  rejected: "bg-red-900/60 text-red-100",
  skipped: "bg-neutral-800 text-neutral-500",
  failed: "bg-amber-800/60 text-amber-100",
};

const ITEM_LABEL: Record<RunItemStatus, string> = {
  pending: "waiting",
  running: "working",
  proposed: "to review",
  accepted: "accepted",
  rejected: "rejected",
  skipped: "skipped",
  failed: "failed",
};

export function ItemBadge({ status }: { status: RunItemStatus }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 text-[10px] uppercase ${ITEM_STYLE[status]}`}
      data-testid="agent-run-item-status"
      data-status={status}
    >
      {ITEM_LABEL[status]}
    </span>
  );
}

/** An approved run: progress per page, the run total, Pause / Resume, and links to review. */
function RunCard({ run, device }: { run: Run; device: Device }) {
  const view = useAgentView();
  const state = useAgentState();
  const driving = state.driving === run.id;
  const idle = !(state.driving || state.streaming);
  const next = nextItem(run, { threadBusy: false });
  const counts = runCounts(run);
  const done = run.items.length - counts.pending - counts.running;
  const toReview = counts.proposed;
  const ctx = { device, selectedKey: null };
  return (
    <div
      className="space-y-2 rounded border border-violet-800/60 bg-neutral-900 p-2"
      data-testid="agent-run"
      data-run-status={run.status}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-neutral-100">{run.summary}</p>
        <span className="shrink-0 rounded bg-neutral-800 px-1.5 text-[10px] uppercase text-neutral-300">
          {run.revertedAt
            ? "reverted"
            : run.status === "active"
              ? driving
                ? "running"
                : "paused"
              : run.status}
        </span>
      </div>
      <div
        className="flex items-center justify-between text-xs text-neutral-400"
        data-testid="agent-run-total"
      >
        <span>
          {done} of {run.items.length} pages done
          {toReview ? ` · ${toReview} to review` : ""}
        </span>
        <span title="Planning and every page of this run">
          Run total {formatUsd(run.costUsd)}
        </span>
      </div>
      <ul className="space-y-1">
        {run.items.map((i, n) => (
          <RunItemRow key={i.id} run={run} item={i} n={n + 1} idle={idle} />
        ))}
      </ul>
      <div className="flex flex-wrap gap-1">
        {run.status === "active" && !run.revertedAt && next && !driving && (
          <Button
            size="sm"
            disabled={!idle}
            onClick={() => void view.driveRun(run.id, ctx)}
            data-testid="agent-run-resume"
          >
            <Play className="h-3.5 w-3.5" />{" "}
            {done ? `Resume (${run.items.length - done} left)` : "Start"}
          </Button>
        )}
        {driving && (
          <Button
            size="sm"
            variant="secondary"
            disabled={state.pausing}
            onClick={() => view.pause()}
            data-testid="agent-run-pause"
          >
            <Pause className="h-3.5 w-3.5" />{" "}
            {state.pausing
              ? "Pausing after this page…"
              : "Pause after this page"}
          </Button>
        )}
        <a
          href={`/admin/agent?run=${encodeURIComponent(run.id)}`}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-accent hover:underline"
          data-testid="agent-run-queue"
        >
          Review queue
        </a>
        {run.status === "active" && !driving && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!idle}
            onClick={() => void view.runAction("cancel", run.id)}
            data-testid="agent-run-cancel"
          >
            <X className="h-3.5 w-3.5" /> Cancel run
          </Button>
        )}
      </div>
    </div>
  );
}

function RunItemRow({
  run,
  item,
  n,
  idle,
}: {
  run: Run;
  item: RunItem;
  n: number;
  idle: boolean;
}) {
  const view = useAgentView();
  const review =
    item.status === "proposed" && item.pageId
      ? `/admin/editor/${item.pageId}${item.changesetIds.length ? `?review=${encodeURIComponent(item.changesetIds.at(-1)!)}` : ""}`
      : null;
  return (
    <li
      className="rounded bg-neutral-950/60 p-1.5 text-xs"
      data-testid="agent-run-item"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-neutral-500">{n}.</span>
        <span className="text-neutral-400">{ACTION_LABEL[item.action]}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-neutral-200"
          title={item.intent}
        >
          /{item.slug}
        </span>
        {item.status === "running" && (
          <Loader2 className="h-3 w-3 animate-spin text-sky-300" />
        )}
        <ItemBadge status={item.status} />
      </div>
      <p className="mt-0.5 line-clamp-2 text-neutral-500">{item.intent}</p>
      {!!item.note && (
        <p className="mt-0.5 text-[11px] text-amber-200/80">{item.note}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        {item.costUsd > 0 && (
          <span className="text-neutral-500">{formatUsd(item.costUsd)}</span>
        )}
        {!!review && (
          <a
            href={review}
            className="text-accent hover:underline"
            data-testid="agent-run-item-review"
          >
            Review on its page
          </a>
        )}
        {!!item.createdPageId && (
          <a
            href={`/admin/editor/${item.createdPageId}`}
            className="text-emerald-300 hover:underline"
            data-testid="agent-run-item-draft"
          >
            Draft (not published)
          </a>
        )}
        {(item.status === "pending" || item.status === "failed") &&
          run.status === "active" && (
            <button
              type="button"
              disabled={!idle}
              className="inline-flex items-center gap-0.5 text-neutral-400 hover:text-white disabled:opacity-40"
              onClick={() => void view.runAction("skip", run.id, item.id)}
              data-testid="agent-run-item-skip"
            >
              <SkipForward className="h-3 w-3" /> Skip
            </button>
          )}
        {(item.status === "failed" || item.status === "skipped") &&
          (run.status === "active" || run.status === "done") &&
          !run.revertedAt && (
            <button
              type="button"
              disabled={!idle}
              className="inline-flex items-center gap-0.5 text-neutral-400 hover:text-white disabled:opacity-40"
              onClick={() => void view.runAction("retry", run.id, item.id)}
              data-testid="agent-run-item-retry"
            >
              <RotateCcw className="h-3 w-3" /> Retry
            </button>
          )}
      </div>
    </li>
  );
}
