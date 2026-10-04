// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
// biome-ignore-all lint/style/useDefaultSwitchClause: switches over closed unions; TypeScript checks exhaustiveness, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { AGENT_MODEL, summarizeUsage } from "@repo/cms-core/agent/cost";
import { systemPrompt } from "@repo/cms-core/agent/prompt";
import { apiTools, toolLabel } from "@repo/cms-core/agent/tool-defs";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import type { SiteConfig } from "@repo/cms-core/site/config";
import type {
  ModelProvider,
  StepInput,
  StepResult,
  StepStop,
} from "./provider";
import type { StoredMessage } from "./store-port";
import { effortOf } from "./transcript";

/**
 * The Claude provider (docs/cms-plan.md §4.1, §4.2): a streaming call to Claude Opus 5.5 with
 * adaptive thinking at medium effort, progress notes (`thinking.display: "updates"`), refusal
 * fallbacks (`fallbacks: "default"`) and eager tool-input streaming. A turn that needs more
 * (site-wide planning) raises the effort with a stored effort-only system message (per-message
 * effort, `output_config` on a `system` message), so the request parameters never change and the
 * cached prefix (tools, system, earlier messages) holds across turns. The transcript is
 * append-only: every message is stored as the API saw it and replayed byte-identically, which keeps
 * Opus 5.5's thinking blocks valid and the prompt cache warm. Images are stored as references
 * (media library or R2) and expanded to base64 on replay (`hydrate`).
 */

export const THINKING_UPDATES_BETA = "thinking-display-updates-2026-08-18";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Per-message effort: a `system` message with empty content and `output_config.effort`. */
export const EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
/** Streaming, so a generous cap (thinking counts toward it); actual spend is what's generated. */
export const MAX_TOKENS = 64_000;
const MAX_JSON_RETRIES = 2;

type StreamLike = AsyncIterable<BetaRawMessageStreamEvent> & {
  finalMessage(): Promise<BetaMessage>;
  readonly currentMessage?: BetaMessage;
};
export type AgentClient = {
  beta: {
    messages: {
      stream(
        params: MessageCreateParamsBase,
        options?: { signal?: AbortSignal }
      ): StreamLike;
    };
  };
};

/** Stored content → API content (image refs → base64). */
export type Hydrate = (
  content: unknown
) => Promise<BetaMessageParam["content"]>;

/** The request parameters minus messages: identical on every request, so tools + system are a stable cached prefix. */
export function requestBase(
  config: SiteConfig
): Omit<MessageCreateParamsBase, "messages"> {
  const system = systemPrompt(config);
  return {
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    betas: [THINKING_UPDATES_BETA, FALLBACK_BETA, EFFORT_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive", display: "updates" },
    output_config: { effort: "medium" },
    tools: apiTools() as MessageCreateParamsBase["tools"],
    system: system.map((text, i) => ({
      type: "text" as const,
      text,
      ...(i === system.length - 1 && {
        cache_control: { type: "ephemeral" as const },
      }),
    })),
    // Automatic breakpoint on the last cacheable block: the conversation so far is reused next turn.
    cache_control: { type: "ephemeral" },
  };
}

/**
 * After a mid-output fallback, blocks before the last `fallback` block that the fallback model
 * can't continue from are dropped before the turn is stored (they are not echoed back).
 */
export function sanitizeAssistant(
  content: BetaContentBlock[]
): BetaContentBlock[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  if (last < 0) {
    return content;
  }
  const drop = new Set([
    "thinking",
    "redacted_thinking",
    "tool_use",
    "server_tool_use",
  ]);
  return content.filter((b, i) => i >= last || !drop.has(b.type));
}

const STOPS: Record<string, StepStop> = {
  end_turn: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

export function anthropicProvider(
  client: AgentClient,
  hydrate: Hydrate,
  config: SiteConfig
): ModelProvider {
  return {
    id: "anthropic",
    model: AGENT_MODEL,
    async step(input) {
      const params: MessageCreateParamsBase = {
        ...requestBase(config),
        messages: await toApiMessages(input.rows, hydrate),
        ...(input.noTools && { tool_choice: { type: "none" } }),
      };
      const message = await streamOnce(client, input, params);
      if (!message) {
        return null;
      }
      const content = sanitizeAssistant(message.content);
      const usage = summarizeUsage(
        message.usage as never,
        message.model,
        AGENT_MODEL
      );
      const calls = content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, name: b.name, input: b.input }]
          : []
      );
      const stop = STOPS[message.stop_reason ?? ""] ?? "other";
      const result: StepResult = {
        assistant: {
          content,
          model: message.model,
          stopReason: message.stop_reason,
          usage: message.usage,
          costUsd: usage.costUsd,
        },
        calls,
        stop,
        stopReason: message.stop_reason,
        usage,
      };
      if (stop === "refusal") {
        result.refusal = {
          category: message.stop_details?.category ?? null,
          explanation: message.stop_details?.explanation ?? null,
        };
      }
      return result;
    },
    toolResultRows(results) {
      if (!results.length) {
        return [];
      }
      return [
        {
          role: "user",
          content: results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError && { is_error: true }),
          })),
        },
      ];
    },
    effortRow(effort) {
      return { output_config: { effort } };
    },
  };
}

/** Stored rows → API messages: content hydrated (image refs → base64); an effort row becomes an effort-only system message. */
export async function toApiMessages(
  rows: StoredMessage[],
  hydrate: Hydrate
): Promise<BetaMessageParam[]> {
  const messages: BetaMessageParam[] = [];
  for (const m of rows) {
    const effort = effortOf(m);
    // The SDK's types don't have `output_config` on a message yet.
    if (effort) {
      messages.push({
        role: "system",
        content: [],
        output_config: { effort },
      } as unknown as BetaMessageParam);
    } else {
      messages.push({
        role: m.role as BetaMessageParam["role"],
        content: await hydrate(m.content),
      });
    }
  }
  return messages;
}

/** Spend of a call that produced no stored message (stopped, failed or retried), when the stream got far enough to report it. */
async function recordLost(
  input: StepInput,
  stream: StreamLike,
  kind: "aborted" | "retry" | "error"
) {
  let snapshot: BetaMessage | undefined;
  try {
    snapshot = stream.currentMessage;
  } catch {
    // No message_start yet.
  }
  if (!snapshot?.usage) {
    return;
  }
  const usage = summarizeUsage(
    snapshot.usage as never,
    snapshot.model,
    AGENT_MODEL
  );
  if (!usage.costUsd) {
    return;
  }
  await input.recordLost(
    kind,
    snapshot.model ?? null,
    snapshot.usage,
    usage.costUsd
  );
}

/** One streamed model call: forwards text, progress notes, tool starts and fallbacks; retries unparseable tool JSON. Null when stopped. */
async function streamOnce(
  client: AgentClient,
  input: StepInput,
  params: MessageCreateParamsBase
): Promise<BetaMessage | null> {
  for (let attempt = 0; ; attempt++) {
    const stream = client.beta.messages.stream(params, {
      signal: input.signal,
    });
    const progress = new Map<number, string>();
    try {
      for await (const event of stream) {
        forward(input, event, progress);
      }
      return await stream.finalMessage();
    } catch (err) {
      if (input.signal?.aborted) {
        await recordLost(input, stream, "aborted");
        return null;
      }
      // Only the SDK's tool-input JSON error is retried; API errors (rate limits, auth, 5xx after retries) go up.
      if (
        err instanceof Anthropic.APIError ||
        !(err instanceof Anthropic.AnthropicError) ||
        attempt >= MAX_JSON_RETRIES
      ) {
        await recordLost(input, stream, "error");
        throw err;
      }
      await recordLost(input, stream, "retry");
      // The retried call starts over: the chat drops what this attempt showed.
      input.emit({ type: "reset" });
      input.emit({
        type: "progress",
        text: "A tool input came back malformed; asking again.",
      });
    }
  }
}

/** Maps stream events to chat events. */
export function forward(
  deps: { emit: (event: AgentEvent) => void },
  event: BetaRawMessageStreamEvent,
  progress: Map<number, string>
) {
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "tool_use") {
        deps.emit({
          type: "tool_start",
          tool: {
            id: block.id,
            name: block.name,
            label: toolLabel(block.name, undefined),
          },
        });
      } else if (block.type === "fallback") {
        deps.emit({
          type: "fallback",
          from: block.from.model,
          to: block.to.model,
        });
      } else if (block.type === "thinking") {
        progress.set(event.index, block.thinking ?? "");
      } else if (block.type === "text" && block.text) {
        deps.emit({ type: "text", text: block.text });
      }
      break;
    }
    case "content_block_delta": {
      const d = event.delta;
      if (d.type === "text_delta") {
        deps.emit({ type: "text", text: d.text });
      } else if (d.type === "thinking_delta") {
        progress.set(
          event.index,
          (progress.get(event.index) ?? "") + d.thinking
        );
      }
      break;
    }
    case "content_block_stop": {
      // Under display "updates" a thinking block with text is a progress note; empty ones are hidden reasoning.
      const note = progress.get(event.index)?.trim();
      if (note) {
        deps.emit({ type: "progress", text: note });
      }
      progress.delete(event.index);
      break;
    }
  }
}
