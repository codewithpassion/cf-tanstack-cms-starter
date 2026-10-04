// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
import type { AgentProviderId } from "@repo/cms-core/agent/models";
import type { AgentEvent, UsageSummary } from "@repo/cms-core/agent/types";
import type { StoredMessage, UsageRow } from "./store-port";
import type { StoredToolContent } from "./tools";
import type { AgentEffort, EffortRowContent } from "./transcript";

/**
 * What the agent loop (server/loop.ts) needs from a model provider: one model call over the
 * stored transcript, and how tool results are stored. The loop owns everything else: the spending
 * caps, Stop and detaching, storing a turn's rows only with its first answer, the tool-round limit,
 * running tools and the chat events. Implementations: server/anthropic.ts (Claude, Anthropic
 * blocks) and server/workers-ai.ts (Workers AI, OpenAI-style messages).
 */

/** One tool call. `inputError` is set when the input couldn't be read: the call is answered with it instead of running. */
export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  inputError?: string;
};

/** How a model call ended, in the loop's terms: tools run only after "tool_use". */
export type StepStop = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export type StepResult = {
  /** The assistant row to store, in the provider's transcript format. */
  assistant: {
    content: unknown;
    model: string;
    stopReason: string | null;
    usage: unknown;
    costUsd: number;
  };
  calls: ToolCall[];
  stop: StepStop;
  /** The provider's own stop reason (reported in `done`). */
  stopReason: string | null;
  usage: UsageSummary;
  refusal?: { category: string | null; explanation: string | null };
};

export type ToolResult = {
  id: string;
  content: StoredToolContent;
  isError: boolean;
};

export type StepInput = {
  /** The transcript so far as stored: history plus this turn's rows. */
  rows: StoredMessage[];
  /** The last round: the model may not call tools. */
  noTools: boolean;
  emit: (event: AgentEvent) => void;
  /** Stop: aborts the call; it then returns null and nothing of it is stored. */
  signal?: AbortSignal;
  /**
   * Records the spend of a call that produced no stored message (stopped, failed or retried).
   * Settles the call's checkpoint, if it saved one.
   */
  recordLost: (
    kind: Exclude<UsageRow["kind"], "streaming">,
    model: string | null,
    usage: unknown,
    costUsd: number
  ) => Promise<void>;
  /**
   * Saves the spend so far of the call in flight (a `streaming` usage row, replaced on each call),
   * so it still counts if the Worker ends mid-stream. The row is deleted when the step's message is
   * stored, or becomes the `recordLost` row. Await every checkpoint before returning.
   */
  checkpoint?: (
    model: string | null,
    usage: unknown,
    costUsd: number
  ) => Promise<void>;
};

export type ModelProvider = {
  /**
   * The stored `system` row that sets the effort from the next user turn on (Claude's per-message
   * effort), or undefined when the provider has no per-message effort: the loop then adds no row
   * and the turn runs at the provider's own setting.
   */
  effortRow?(effort: AgentEffort): EffortRowContent;
  readonly id: AgentProviderId;
  readonly model: string;
  /** One model call, streaming text and progress to `emit`. Null when stopped. Throws on API errors. */
  step(input: StepInput): Promise<StepResult | null>;
  /** Stored rows answering tool calls, in order (one `user` row of `tool_result` blocks, or one `tool` row per call). */
  toolResultRows(
    results: ToolResult[]
  ): Pick<StoredMessage, "role" | "content">[];
};
