// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
import type { StoredMessage } from "./store-port";
import type { StoredToolContent } from "./tools";

/**
 * Reading stored transcripts of either provider (pure). An `anthropic` thread stores Anthropic
 * content blocks: tool calls are `tool_use` blocks in assistant rows, results `tool_result` blocks
 * in one `user` row. A `workers-ai` thread stores OpenAI-style messages: an assistant row's content
 * is `WorkersAiAssistant` (text, `tool_calls`, reasoning), each result is its own `tool` row. User
 * and system rows look the same in both (text and image refs). The loop's repairs, the thread
 * limits and the chat view read transcripts through these helpers.
 */

/** A `workers-ai` assistant row's content. `reasoning_content` is shown in the chat, never sent back. */
export type WorkersAiAssistant = {
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  reasoning_content?: string;
};

/** A `workers-ai` tool row's content: the result of one call (same content shape as Anthropic tool results). */
export type WorkersAiToolResult = {
  tool_call_id: string;
  content: StoredToolContent;
  is_error?: boolean;
};

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  text?: string;
  content?: unknown;
  is_error?: boolean;
};

export const blocksOf = (m: StoredMessage): Block[] =>
  Array.isArray(m.content) ? (m.content as Block[]) : [];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The content of a `workers-ai` assistant row, or null for an Anthropic one. */
export function workersAiAssistant(
  m: StoredMessage
): WorkersAiAssistant | null {
  return m.role === "assistant" && isObject(m.content)
    ? (m.content as WorkersAiAssistant)
    : null;
}

export function workersAiToolResult(
  m: StoredMessage
): WorkersAiToolResult | null {
  return m.role === "tool" && isObject(m.content)
    ? (m.content as WorkersAiToolResult)
    : null;
}

/**
 * A per-message effort row (Anthropic threads): a stored `system` row whose content is
 * `{ output_config: { effort } }`, sent as an effort-only system message. Not text: the chat,
 * the thread limits and the Workers AI conversion skip it.
 */
export type EffortRowContent = { output_config: { effort: AgentEffort } };
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function effortOf(m: StoredMessage): AgentEffort | null {
  if (m.role !== "system" || !isObject(m.content)) {
    return null;
  }
  const oc = (m.content as Record<string, unknown>).output_config;
  return isObject(oc) && typeof oc.effort === "string"
    ? (oc.effort as AgentEffort)
    : null;
}

/** The effort the next request runs at: the latest effort row's, or null (the request's own). */
export function currentEffort(rows: StoredMessage[]): AgentEffort | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = effortOf(rows[i]!);
    if (e) {
      return e;
    }
  }
  return null;
}

/** A row that carries tool results (an Anthropic `user` row with `tool_result` blocks, or a `tool` row). */
export const isToolResults = (m: StoredMessage) =>
  m.role === "tool" ||
  (m.role === "user" && blocksOf(m).some((b) => b.type === "tool_result"));

/** A user row that carries the user's own message (not tool results). */
export const isUserTurn = (m: StoredMessage) =>
  m.role === "user" && !isToolResults(m);

/** A tool call in either format; `input` is parsed (Workers AI arguments are a JSON string). */
export type StoredCall = { id: string; name: string; input: unknown };

export function toolCallsOf(m: StoredMessage): StoredCall[] {
  if (m.role !== "assistant") {
    return [];
  }
  const wai = workersAiAssistant(m);
  if (wai) {
    return (wai.tool_calls ?? []).map((c) => {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = undefined;
      }
      return { id: c.id, name: c.function.name, input };
    });
  }
  return blocksOf(m)
    .filter((b) => b.type === "tool_use" && b.id)
    .map((b) => ({ id: b.id!, name: b.name ?? "", input: b.input }));
}

/** A tool result in either format. */
export type StoredResult = {
  callId: string;
  content: unknown;
  isError: boolean;
};

export function toolResultsOf(m: StoredMessage): StoredResult[] {
  const wai = workersAiToolResult(m);
  if (wai) {
    return [
      {
        callId: wai.tool_call_id,
        content: wai.content,
        isError: !!wai.is_error,
      },
    ];
  }
  if (m.role !== "user") {
    return [];
  }
  return blocksOf(m)
    .filter((b) => b.type === "tool_result" && b.tool_use_id)
    .map((b) => ({
      callId: b.tool_use_id!,
      content: b.content,
      isError: !!b.is_error,
    }));
}

/** The assistant's visible text of a row. */
export function assistantTexts(m: StoredMessage): string[] {
  if (m.role !== "assistant") {
    return [];
  }
  const wai = workersAiAssistant(m);
  if (wai) {
    return wai.content?.trim() ? [wai.content] : [];
  }
  return blocksOf(m).flatMap((b) =>
    b.type === "text" && b.text?.trim() ? [b.text] : []
  );
}

/** Images in a row's content (inside tool results too). */
export function countImages(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((s: number, n) => s + countImages(n), 0);
  }
  if (!isObject(node)) {
    return 0;
  }
  if (node.type === "image") {
    return 1;
  }
  // Anthropic tool_result blocks and Workers AI tool rows both keep their content in `content`.
  return node.type === "tool_result" || "tool_call_id" in node
    ? countImages(node.content)
    : 0;
}

/**
 * Input tokens of a request plus its reply (what the next request sends again), from either
 * provider's usage. Workers AI reasoning isn't sent back, so its reasoning tokens (when reported
 * separately) don't count.
 */
export function contextTokensOf(usage: unknown): number {
  if (!isObject(usage)) {
    return 0;
  }
  const n = (k: string) =>
    typeof usage[k] === "number" ? (usage[k] as number) : 0;
  if ("prompt_tokens" in usage) {
    const details = usage.completion_tokens_details;
    const reasoning =
      isObject(details) && typeof details.reasoning_tokens === "number"
        ? details.reasoning_tokens
        : 0;
    return n("prompt_tokens") + Math.max(0, n("completion_tokens") - reasoning);
  }
  return (
    n("input_tokens") +
    n("cache_read_input_tokens") +
    n("cache_creation_input_tokens") +
    n("output_tokens")
  );
}
