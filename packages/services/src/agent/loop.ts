// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useAtIndex: ported verbatim; kept as in the source.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
import type { BudgetStatus } from "@repo/cms-core/agent/budget-types";
import { toolLabel } from "@repo/cms-core/agent/tool-defs";
import type { AgentEvent, UsageSummary } from "@repo/cms-core/agent/types";
import type { ModelProvider, ToolResult } from "./provider";
import type { AgentStore, StoredMessage, UsageRow } from "./store-port";
import {
  runTool,
  type StoredToolContent,
  type ToolCtx,
  type ToolDeps,
  type ToolScope,
} from "./tools";
import {
  type AgentEffort,
  currentEffort,
  isToolResults,
  toolCallsOf,
  toolResultsOf,
} from "./transcript";

/**
 * The agent's tool loop (docs/cms-plan.md §4.1, §4.2), shared by both providers: model call ↔
 * tools until the model is done. The thread's provider (server/provider.ts) makes each model call
 * and decides how its messages and tool results are stored; this loop checks the spending caps
 * before every call, handles Stop (the call in flight is aborted and nothing of it is stored) and a
 * closed tab, stores a turn's own rows only together with its first answer, runs tools only after
 * a tool-use stop, and limits the tool rounds. The transcript is append-only.
 */

export const MAX_TOOL_ROUNDS = 25;
/** The effort of a request without an effort row (server/anthropic.ts `requestBase`). */
const DEFAULT_EFFORT: AgentEffort = "medium";

export type LoopDeps = {
  /** The thread's model: `providerFor` (models.ts) builds it from the thread's provider and model. */
  provider: ModelProvider;
  store: AgentStore;
  tools: ToolDeps;
  emit: (event: AgentEvent) => void;
  /** Stop: aborts the model call in flight; what it produced is dropped. */
  signal?: AbortSignal;
  /** True once the client has gone away (tab closed): the current model call finishes and is stored, then the turn ends. */
  detached?: () => boolean;
  /** The spending caps, checked before every model call. */
  budget?: () => Promise<BudgetStatus>;
  now?: () => number;
};

export type TurnInput = {
  threadId: string;
  /** The page render and write tools act on (null: none yet, see `ToolCtx.pageId`). */
  pageId: string | null;
  /** Missing = the thread's page. */
  scope?: ToolScope;
  /**
   * The effort this turn should run at (`high` for site-wide planning). With a provider that has
   * per-message effort (Claude), an effort row is stored before the user message when the
   * thread's current effort differs; it then holds for later turns too. Other providers ignore it.
   */
  effort?: AgentEffort;
  /**
   * Collects what the turn's tools stage and create (a run item's outcome). Passed in so the
   * caller still has it when the turn throws.
   */
  produced?: NonNullable<ToolCtx["produced"]>;
  /** The user's message content as stored (text + image refs). Omitted to continue a turn that paused on a spending cap. */
  user?: StoredToolContent;
  /** The turn's context, as a mid-conversation system message. */
  context?: string;
  /** The latest decision reported in `user`: recorded together with the turn's first stored rows. */
  decisionsReportedAt?: Date;
};

/** Error results for tool calls that will not run, so the transcript stays valid (every call answered). */
function unrun(ids: string[], reason: string): ToolResult[] {
  return ids.map((id) => ({ id, content: reason, isError: true }));
}

/** Tool calls of the last stored assistant message that never got results (an interrupted request). */
export function danglingToolUses(history: StoredMessage[]): string[] {
  const lastAssistant = history.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistant < 0) {
    return [];
  }
  const ids = toolCallsOf(history[lastAssistant]!).map((c) => c.id);
  const answered = new Set(
    history
      .slice(lastAssistant + 1)
      .flatMap((m) => toolResultsOf(m).map((r) => r.callId))
  );
  return ids.filter((id) => !answered.has(id));
}

/**
 * Rows of a turn that never got an answer: when the rows after the last assistant message include
 * a system message, that turn's user and system rows (tool results stay, they answer the assistant
 * message). A system message must be followed by an assistant message, so such a tail would make
 * every later request invalid. Nothing the model produced follows them, so deleting them keeps the
 * stored thinking blocks valid. Since the turn's rows are stored only together with its first
 * answer, this repairs transcripts written before that.
 */
export function unansweredTail(history: StoredMessage[]): number[] {
  const lastAssistant = history.map((m) => m.role).lastIndexOf("assistant");
  const tail = history.slice(lastAssistant + 1);
  if (!tail.some((m) => m.role === "system")) {
    return [];
  }
  return tail.filter((m) => !isToolResults(m)).map((m) => m.seq);
}

/**
 * Runs one user turn: loops model ↔ tools until the model is done. The turn's own rows (repairs,
 * the user message, the context) are stored only together with the first answer, so a turn whose
 * first model call fails or is stopped leaves the transcript as it was.
 */
export async function runTurn(
  deps: LoopDeps,
  input: TurnInput
): Promise<{ usage: UsageSummary[]; stopReason: string | null; ctx: ToolCtx }> {
  const { provider } = deps;
  const now = () => new Date(deps.now?.() ?? Date.now());
  let history = await deps.store.messages(input.threadId);
  const broken = unansweredTail(history);
  if (broken.length) {
    await deps.store.deleteRows(input.threadId, broken);
    history = history.filter((m) => !broken.includes(m.seq));
  }
  let seq = history.length ? history[history.length - 1]!.seq + 1 : 0;
  const rows: StoredMessage[] = [...history];
  const pending: StoredMessage[] = [];
  let first = true;
  /** The `streaming` usage row of the model call in flight, and rows to delete with the next append (their calls' messages). */
  let inFlight: string | null = null;
  const settle: string[] = [];
  const add = (
    role: StoredMessage["role"],
    content: unknown,
    extra: Partial<StoredMessage> = {}
  ) => {
    const row: StoredMessage = {
      seq: seq++,
      role,
      content,
      createdAt: now(),
      ...extra,
    };
    pending.push(row);
    rows.push(row);
    return row;
  };
  const addResults = (results: ToolResult[]) => {
    for (const r of provider.toolResultRows(results)) {
      add(r.role, r.content);
    }
  };
  const flush = async () => {
    if (!pending.length) {
      return;
    }
    await deps.store.append(input.threadId, pending, {
      at: now(),
      ...(first &&
        input.decisionsReportedAt && {
          decisionsReportedAt: input.decisionsReportedAt,
        }),
      ...(settle.length && { settleUsage: [...settle] }),
    });
    pending.length = 0;
    settle.length = 0;
    first = false;
  };
  const writeUsage = (
    id: string,
    kind: UsageRow["kind"],
    model: string | null,
    usage: unknown,
    costUsd: number
  ) =>
    deps.store.recordUsage({
      id,
      threadId: input.threadId,
      kind,
      model,
      usage,
      costUsd,
      createdAt: now(),
    });
  const recordLost = async (
    kind: Exclude<UsageRow["kind"], "streaming">,
    model: string | null,
    usage: unknown,
    costUsd: number
  ) => {
    const id = inFlight ?? crypto.randomUUID();
    inFlight = null;
    await writeUsage(id, kind, model, usage, costUsd);
  };
  const checkpoint = async (
    model: string | null,
    usage: unknown,
    costUsd: number
  ) => {
    inFlight ??= crypto.randomUUID();
    await writeUsage(inFlight, "streaming", model, usage, costUsd);
  };

  // Repair an interrupted request (tool calls without results) by appending error results.
  const dangling = danglingToolUses(history);
  if (dangling.length) {
    addResults(unrun(dangling, "Interrupted before it ran."));
  }
  // The default is the provider's request-level effort; an effort row changes it from the next user turn on.
  if (
    input.effort &&
    provider.effortRow &&
    (currentEffort(history) ?? DEFAULT_EFFORT) !== input.effort
  ) {
    add("system", provider.effortRow(input.effort));
  }
  if (input.user !== undefined) {
    add("user", input.user);
  }
  if (input.context !== undefined) {
    add("system", input.context);
  }

  const ctx: ToolCtx = {
    threadId: input.threadId,
    pageId: input.pageId,
    counts: { preview: 0, share: 0, create: 0 },
    ...(input.scope && { scope: input.scope }),
    produced: input.produced ?? { changesetIds: [], createdPageIds: [] },
  };
  const usages: UsageSummary[] = [];
  let stopReason: string | null = null;

  for (let round = 0; ; round++) {
    // Stopped between calls: what ran so far is stored.
    if (deps.signal?.aborted) {
      stopReason = "stopped";
      break;
    }
    if (round > 0 && deps.detached?.()) {
      stopReason = "detached";
      break;
    }
    const budget = await deps.budget?.();
    if (budget?.blocked) {
      deps.emit({ type: "budget", budget });
      stopReason = "budget";
      break;
    }
    const lastRound = round >= MAX_TOOL_ROUNDS;
    deps.emit({ type: "call_start" });
    const step = await provider.step({
      rows,
      noTools: lastRound,
      emit: deps.emit,
      signal: deps.signal,
      recordLost,
      checkpoint,
    });
    // The call's checkpoint is replaced by its stored message (in the same write), or stays as its spend if nothing is stored.
    if (inFlight && step) {
      settle.push(inFlight);
    }
    inFlight = null;
    if (!step) {
      stopReason = "aborted";
      break;
    }
    stopReason = step.stopReason;
    const usage = step.usage;
    usages.push(usage);
    add("assistant", step.assistant.content, {
      model: step.assistant.model,
      stopReason: step.assistant.stopReason,
      usage: step.assistant.usage,
      costUsd: step.assistant.costUsd,
    });

    const calls = step.calls;
    const notRun = (reason: string) => {
      if (calls.length) {
        addResults(
          unrun(
            calls.map((c) => c.id),
            reason
          )
        );
      }
    };
    const finish = async () => {
      await flush();
      deps.emit({
        type: "usage",
        usage,
        threadCostUsd: await deps.store.threadCost(input.threadId),
      });
      const after = await deps.budget?.();
      if (after) {
        deps.emit({ type: "budget", budget: after });
      }
    };

    if (step.stop === "refusal") {
      notRun("Not run: the response was declined.");
      await finish();
      deps.emit({
        type: "refusal",
        category: step.refusal?.category ?? null,
        explanation: step.refusal?.explanation ?? null,
      });
      break;
    }
    if (step.stop === "max_tokens") {
      notRun(
        "Not run: the response hit the output limit and the input may be cut off."
      );
      await finish();
      deps.emit({
        type: "notice",
        text: "The reply hit the output limit and may be cut off.",
      });
      break;
    }
    if (!calls.length) {
      await finish();
      break;
    }
    // Tools run only when the model stopped to use them.
    if (step.stop !== "tool_use") {
      notRun(`Not run: the response ended with "${step.stopReason}".`);
      await finish();
      break;
    }
    if (deps.detached?.()) {
      notRun("Not run: the conversation was closed before it ran.");
      await finish();
      stopReason = "detached";
      break;
    }
    await finish();

    // Run this round's tools in the order the model called them: a render_preview after a
    // propose_ops in the same response must see the staged changeset. All results are stored together.
    const results: ToolResult[] = [];
    for (const call of calls) {
      deps.emit({
        type: "tool_start",
        tool: {
          id: call.id,
          name: call.name,
          label: toolLabel(call.name, call.input as Record<string, unknown>),
        },
      });
      if (call.inputError !== undefined) {
        const content = JSON.stringify({
          ok: false,
          errors: [{ code: "INVALID_INPUT", message: call.inputError }],
        });
        deps.emit({
          type: "tool_end",
          id: call.id,
          ok: false,
          summary: "Invalid input (asked to fix it)",
        });
        results.push({ id: call.id, content, isError: true });
        continue;
      }
      const out = await runTool(deps.tools, ctx, call.name, call.input);
      deps.emit({
        type: "tool_end",
        id: call.id,
        ok: !out.isError,
        summary: out.summary,
        ...(out.image && { image: out.image }),
      });
      if (out.changeset) {
        deps.emit({ type: "changeset", changeset: out.changeset });
      }
      if (out.created) {
        deps.emit({ type: "created", page: out.created });
      }
      if (out.plan) {
        deps.emit({ type: "plan", run: out.plan });
      }
      results.push({ id: call.id, content: out.content, isError: out.isError });
    }
    addResults(results);
    await flush();
    if (lastRound) {
      break;
    }
  }
  // Every stored step flushed already; rows still pending belong to a turn that got no answer and are dropped.
  return { usage: usages, stopReason, ctx };
}
