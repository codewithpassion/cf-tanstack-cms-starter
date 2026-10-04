// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/performance/noDelete: drops the request body's messages (and their images) once streaming starts, so the memory can be freed, as in the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; constructor parameter properties as in the source.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/style/useErrorCause: ported verbatim; the message carries what the user needs and the original error is logged where it matters, as in the source.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: intentional no-op callbacks and ignored failures, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
import {
  summarizeWorkersAiUsage,
  type WorkersAiUsage,
} from "@repo/cms-core/agent/cost";
import { GLM_FLASH_MODEL_ID } from "@repo/cms-core/agent/models";
import { systemPrompt } from "@repo/cms-core/agent/prompt";
import { toolLabel, workersAiTools } from "@repo/cms-core/agent/tool-defs";
import type { SiteConfig } from "@repo/cms-core/site/config";
import type { Hydrate } from "./anthropic";
import type {
  ModelProvider,
  StepInput,
  StepResult,
  StepStop,
  ToolCall,
} from "./provider";
import type { StoredMessage } from "./store-port";
import {
  effortOf,
  type WorkersAiAssistant,
  workersAiAssistant,
  workersAiToolResult,
} from "./transcript";

/**
 * The Workers AI provider: a streamed chat completion through the `AI` binding
 * (`env.AI.run(model, { messages, tools, stream: true })`), OpenAI-style. Built for GLM-5.3 Flash
 * (function calling, vision, reasoning); other Workers AI text-generation models with function
 * calling work the same way. Differences from the Claude path:
 * - The transcript is stored as OpenAI-style messages (server/transcript.ts); each tool result is a
 *   `tool` row.
 * - A `tool` message takes text only, so images a tool returned (render_preview,
 *   render_share_image) go in a `user` message right after the tool messages, as data URLs read
 *   from R2 when the request is built.
 * - The model's reasoning (`reasoning_content`) is shown in the chat, collapsed, and stored, but
 *   not sent back (the model docs don't ask for it).
 * - No prompt-cache breakpoints or refusal fallbacks; Workers AI caches prompt prefixes on its own
 *   (`cached_tokens`).
 * - Requests carry only the latest MAX_REQUEST_IMAGES images and no GIFs; replayed tool calls
 *   always have valid JSON arguments (the API refuses a transcript with a cut-off call).
 * - A busy model (out of capacity, rate-limited) is asked again a few times before anything
 *   streams; other errors reach the chat as plain text (`workersAiErrorText`).
 * - The spend of a streaming call is saved as it streams (`StepInput.checkpoint`), so a call cut
 *   off when the Worker ends (a closed tab, past the `waitUntil` window) is still counted.
 */

/** The binding's shape that this module uses (`Ai` in worker-configuration.d.ts). */
export type AiBinding = {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
};

/**
 * Per-model settings. `reasoningEffort`: GLM-5.3 Flash defaults to "max", which is slow.
 * `contextTokens`: the model's context window (from its model page), which caps the output budget.
 */
const MODEL_OPTIONS: Record<
  string,
  { reasoningEffort?: "low" | "high" | "max"; contextTokens?: number }
> = {
  [GLM_FLASH_MODEL_ID]: { reasoningEffort: "high", contextTokens: 1_048_576 },
};

/** Includes reasoning. Lower for a model whose context window is known to be smaller. */
export const MAX_COMPLETION_TOKENS = 32_000;

export function maxCompletionTokens(model: string): number {
  return Math.min(
    MAX_COMPLETION_TOKENS,
    MODEL_OPTIONS[model]?.contextTokens ?? MAX_COMPLETION_TOKENS
  );
}

/**
 * Images sent inline in one request: the latest ones. Older images stay in the stored transcript
 * but go as a text placeholder, so a long thread doesn't re-send (and re-read from R2) every
 * screenshot on every call.
 */
export const MAX_REQUEST_IMAGES = 8;
export const OMITTED_IMAGE = "[earlier image omitted]";
/** The Workers AI model pages don't say GIF is accepted, so GIFs go as a note. */
export const GIF_IMAGE = "[A GIF image, which this model can't view.]";

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export type WorkersAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Part[] }
  | {
      role: "assistant";
      content: string;
      tool_calls?: WorkersAiAssistant["tool_calls"];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type Hydrated = {
  type?: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string };
};

/** Hydrated content (base64 image blocks) → text and image_url parts. */
function parts(content: unknown): Part[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as Hydrated[]).flatMap((b): Part[] => {
    if (b.type === "text" && typeof b.text === "string") {
      return [{ type: "text", text: b.text }];
    }
    if (b.type === "image" && b.source?.media_type === "image/gif") {
      return [{ type: "text", text: GIF_IMAGE }];
    }
    if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
      return [
        {
          type: "image_url",
          image_url: {
            url: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        },
      ];
    }
    return [];
  });
}

const textOf = (ps: Part[]) =>
  ps.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

/**
 * The rows with images the request won't carry replaced by text, before anything is read from R2:
 * GIFs, and all but the latest `max` images (user attachments and tool screenshots alike).
 * Returns copies of the changed rows; the stored rows are untouched.
 */
export function limitImages(
  rows: StoredMessage[],
  max: number
): StoredMessage[] {
  let kept = 0;
  const fix = (blocks: unknown[]): unknown[] => {
    const out = [...blocks];
    for (let i = out.length - 1; i >= 0; i--) {
      const b = out[i] as Hydrated | null;
      if (b?.type !== "image") {
        continue;
      }
      if (b.source?.media_type === "image/gif") {
        out[i] = { type: "text", text: GIF_IMAGE };
      } else if (kept >= max) {
        out[i] = { type: "text", text: OMITTED_IMAGE };
      } else {
        kept++;
      }
    }
    return out;
  };
  const out = [...rows];
  for (let r = rows.length - 1; r >= 0; r--) {
    const m = rows[r]!;
    if (m.role === "user" && Array.isArray(m.content)) {
      out[r] = { ...m, content: fix(m.content) };
    }
    const t = workersAiToolResult(m);
    if (t && Array.isArray(t.content)) {
      out[r] = { ...m, content: { ...t, content: fix(t.content) } };
    }
  }
  return out;
}

/** A tool call's arguments as the request sends them: valid JSON, or `{}` (the API refuses a replayed call whose arguments don't parse). */
function replayArguments(args: string): string {
  try {
    JSON.parse(args);
    return args;
  } catch {
    return "{}";
  }
}

/**
 * Stored rows → Workers AI messages. Images in tool results follow the run of tool messages in one
 * user message, each introduced by its call id. Only the latest MAX_REQUEST_IMAGES images are
 * sent (see `limitImages`). A tool call cut off mid-arguments (a reply that hit the output limit,
 * or malformed JSON) is replayed with `{}`: its stored result already says it didn't run.
 */
export async function toWorkersAiMessages(
  stored: StoredMessage[],
  hydrate: Hydrate,
  maxImages = MAX_REQUEST_IMAGES
): Promise<WorkersAiMessage[]> {
  const rows = limitImages(stored, maxImages);
  const out: WorkersAiMessage[] = [];
  let toolImages: Part[] = [];
  const flushImages = () => {
    if (!toolImages.length) {
      return;
    }
    out.push({
      role: "user",
      content: [
        { type: "text", text: "[Images returned by the tool calls above.]" },
        ...toolImages,
      ],
    });
    toolImages = [];
  };
  for (const m of rows) {
    if (m.role !== "tool") {
      flushImages();
    }
    // An effort row (Claude's per-message effort) never reaches Workers AI.
    if (effortOf(m)) {
      continue;
    }
    if (m.role === "system") {
      out.push({
        role: "system",
        content:
          typeof m.content === "string" ? m.content : textOf(parts(m.content)),
      });
    } else if (m.role === "user") {
      const ps = parts(await hydrate(m.content));
      out.push({
        role: "user",
        content:
          typeof m.content === "string"
            ? m.content
            : ps.every((p) => p.type === "text")
              ? textOf(ps)
              : ps,
      });
    } else if (m.role === "assistant") {
      const a = workersAiAssistant(m);
      if (!a) {
        continue;
      }
      const calls = a.tool_calls?.map((c) => ({
        ...c,
        function: {
          ...c.function,
          arguments: replayArguments(c.function.arguments),
        },
      }));
      out.push({
        role: "assistant",
        content: a.content ?? "",
        ...(calls?.length ? { tool_calls: calls } : {}),
      });
    } else {
      const r = workersAiToolResult(m);
      if (!r) {
        continue;
      }
      const ps = parts(await hydrate(r.content));
      const images = ps.filter((p) => p.type === "image_url");
      let text = textOf(ps);
      if (images.length) {
        text += `\n(${images.length === 1 ? "The image is" : "The images are"} in the next message.)`;
        toolImages.push(
          { type: "text", text: `Image from tool call ${r.tool_call_id}:` },
          ...images
        );
      }
      out.push({
        role: "tool",
        tool_call_id: r.tool_call_id,
        content: r.is_error ? `Error: ${text}` : text,
      });
    }
  }
  flushImages();
  return out;
}

/** A Workers AI error as the binding throws it: `<code>: {"message": …, "code": <HTTP status>}` (or plain text after the code). */
export type WorkersAiErrorInfo = {
  code: number | null;
  status: number | null;
  message: string;
};

export function parseWorkersAiError(err: unknown): WorkersAiErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^\s*(\d{3,5}):?\s*([\s\S]*)$/.exec(raw);
  if (!m) {
    return { code: null, status: null, message: raw };
  }
  let message = m[2]!.trim();
  let status: number | null = null;
  try {
    const body = JSON.parse(message) as {
      message?: unknown;
      error?: unknown;
      code?: unknown;
    };
    const text =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : null;
    if (text) {
      message = text;
    }
    if (typeof body.code === "number") {
      status = body.code;
    }
  } catch {
    // Plain text after the code.
  }
  return { code: Number(m[1]), status, message };
}

/** Out of capacity (3040) or rate-limited: worth a retry after a short wait. Not the free plan's daily allocation (3036). */
export function isRetryable(e: WorkersAiErrorInfo): boolean {
  if (e.code === 3036) {
    return false;
  }
  return (
    e.code === 3040 ||
    e.status === 429 ||
    /capacity temporarily exceeded|too many requests|rate.?limit/i.test(
      e.message
    )
  );
}

/** What the chat shows for a Workers AI error (no raw codes or JSON). */
export function workersAiErrorText(
  e: WorkersAiErrorInfo,
  attempts = 1
): string {
  const tried = attempts > 1 ? ` (tried ${attempts} times)` : "";
  if (isRetryable(e)) {
    return `Workers AI is busy right now${tried}. Try again in a minute.`;
  }
  if (e.code === 3036) {
    return "The Workers AI daily free allocation is used up; the account needs the Workers Paid plan.";
  }
  if (e.code === 3006 || e.status === 413) {
    return "This conversation is too large for Workers AI. Start a new thread to keep going.";
  }
  if (e.code === 3007 || e.code === 3008 || e.status === 408) {
    return "Workers AI timed out. Try again.";
  }
  if (e.code === 5007 || e.code === 3042 || e.status === 404) {
    return "Workers AI doesn't know this model. Check its id in AI settings.";
  }
  return `Workers AI refused the request${e.code ? ` (error ${e.code})` : ""}: ${e.message}`;
}

/** A Workers AI error with chat-ready text; the binding's error is the cause. */
export class WorkersAiError extends Error {
  constructor(
    message: string,
    readonly info: WorkersAiErrorInfo,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "WorkersAiError";
  }
}

/** Waits before a retry; false when Stop came first. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reads `data:` lines of a server-sent event stream as JSON, until `[DONE]`. `signal` cancels the stream (it then just ends). */
export async function* sseJson(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop()!;
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data) {
          continue;
        }
        if (data === "[DONE]") {
          return;
        }
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // Not JSON: skip it.
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

type Delta = {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?:
    | {
        index?: number | null;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      }[]
    | null;
};
type Chunk = {
  model?: string;
  response?: unknown;
  usage?: WorkersAiUsage;
  choices?: { delta?: Delta; finish_reason?: string | null }[];
};

const STOPS: Record<string, StepStop> = {
  stop: "end",
  tool_calls: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

type UsageSum = {
  prompt_tokens: number;
  completion_tokens: number;
  neurons: number;
  cached: number;
  reasoning: number;
};

/** Streamed chunks report their own increments; their sum is the call's usage so far. */
function addUsage(sum: UsageSum, u: WorkersAiUsage) {
  sum.prompt_tokens += u.prompt_tokens ?? 0;
  sum.completion_tokens += u.completion_tokens ?? 0;
  sum.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
  sum.reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0;
  sum.neurons += u.neurons ?? 0;
}

function parseCall(id: string, name: string, args: string): ToolCall {
  try {
    return { id, name, input: args.trim() ? JSON.parse(args) : {} };
  } catch (err) {
    return {
      id,
      name,
      input: undefined,
      inputError: `The arguments weren't valid JSON (${err instanceof Error ? err.message : String(err)}). Send the call again with a JSON object.`,
    };
  }
}

/** Retries of a busy (out of capacity / rate-limited) call before anything streamed, and the waits before them. */
export const RETRY_DELAYS_MS = [1000, 3000, 8000];
/** How often the spend of a streaming call is saved (besides its first usage report). */
export const CHECKPOINT_MS = 5000;

export type WorkersAiOptions = {
  retryDelaysMs?: number[];
  checkpointMs?: number;
};

/**
 * `newHydrate` makes a hydrator for one request: its image cache goes away once the request's
 * messages are built, instead of holding every image of the turn.
 */
export function workersAiProvider(
  ai: AiBinding,
  model: string,
  newHydrate: () => Hydrate,
  config: SiteConfig,
  opts: WorkersAiOptions = {}
): ModelProvider {
  const options = MODEL_OPTIONS[model] ?? {};
  return {
    id: "workers-ai",
    model,
    async step(input) {
      const system = systemPrompt(config).join("\n\n");
      // The messages live only in `body`, which drops them once the stream starts.
      const body: Record<string, unknown> = {
        messages: [
          { role: "system" as const, content: system },
          ...(await toWorkersAiMessages(input.rows, newHydrate())),
        ],
        tools: workersAiTools(),
        tool_choice: input.noTools ? "none" : "auto",
        max_completion_tokens: maxCompletionTokens(model),
        stream: true,
        stream_options: { include_usage: true },
        ...(options.reasoningEffort && {
          reasoning_effort: options.reasoningEffort,
        }),
      };
      return streamStep(ai, model, body, input, opts);
    },
    toolResultRows(results) {
      return results.map((r) => ({
        role: "tool" as const,
        content: {
          tool_call_id: r.id,
          content: r.content,
          ...(r.isError && { is_error: true }),
        },
      }));
    },
  };
}

type CallAcc = { id: string; name: string; args: string };

async function streamStep(
  ai: AiBinding,
  requested: string,
  body: Record<string, unknown>,
  input: StepInput,
  opts: WorkersAiOptions
): Promise<StepResult | null> {
  const retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const checkpointMs = opts.checkpointMs ?? CHECKPOINT_MS;
  let model = requested;
  let text = "";
  let reasoning = "";
  let reasoningShown = 0;
  // Tool calls in stream order, found by their index, else by id, else the latest (a continuation).
  const calls: CallAcc[] = [];
  const byIndex = new Map<number, CallAcc>();
  let finish: string | null = null;
  let final: WorkersAiUsage | null = null;
  let started = false;
  const sum: UsageSum = {
    prompt_tokens: 0,
    completion_tokens: 0,
    neurons: 0,
    cached: 0,
    reasoning: 0,
  };
  const usageSoFar = (): WorkersAiUsage =>
    final ?? {
      prompt_tokens: sum.prompt_tokens,
      completion_tokens: sum.completion_tokens,
      prompt_tokens_details: { cached_tokens: sum.cached },
      ...(sum.reasoning > 0 && {
        completion_tokens_details: { reasoning_tokens: sum.reasoning },
      }),
      neurons: sum.neurons,
    };
  // Reasoning shows as one collapsed note per stretch, once text or a tool call follows it.
  const showReasoning = () => {
    const note = reasoning.slice(reasoningShown).trim();
    reasoningShown = reasoning.length;
    if (note) {
      input.emit({ type: "progress", text: note, reasoning: true });
    }
  };
  // The spend so far is saved as it streams (first report, then every few seconds), in order.
  let saved: Promise<void> = Promise.resolve();
  let lastSave = Number.NEGATIVE_INFINITY;
  const checkpoint = () => {
    if (!input.checkpoint || Date.now() - lastSave < checkpointMs) {
      return;
    }
    const usage = usageSoFar();
    const cost = summarizeWorkersAiUsage(usage, model).costUsd;
    if (!cost) {
      return;
    }
    lastSave = Date.now();
    const at = model;
    saved = saved
      .then(() => input.checkpoint!(at, usage, cost))
      .catch((err: unknown) =>
        console.error("agent: saving streaming spend failed", err)
      );
  };
  const lost = async (kind: "aborted" | "error") => {
    await saved;
    const usage = usageSoFar();
    const cost = summarizeWorkersAiUsage(usage, model).costUsd;
    if (cost) {
      await input.recordLost(kind, model, usage, cost);
    }
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const stream = await ai.run(requested, body, { signal: input.signal });
      if (!(stream instanceof ReadableStream)) {
        throw new Error("Workers AI didn't return a stream.");
      }
      for await (const raw of sseJson(stream, input.signal)) {
        if (!started) {
          started = true;
          // Retries are over: the request's copy of the images isn't needed any more.
          delete body.messages;
        }
        const chunk = raw as Chunk;
        if ("response" in chunk) {
          // The closing event: the totals.
          if (chunk.usage) {
            final = chunk.usage;
          }
          continue;
        }
        if (chunk.model) {
          model = chunk.model;
        }
        if (chunk.usage) {
          addUsage(sum, chunk.usage);
          checkpoint();
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
        }
        if (delta?.content) {
          showReasoning();
          text += delta.content;
          input.emit({ type: "text", text: delta.content });
        }
        for (const tc of delta?.tool_calls ?? []) {
          showReasoning();
          const index = typeof tc.index === "number" ? tc.index : null;
          let call =
            index === null
              ? tc.id
                ? calls.find((c) => c.id === tc.id)
                : calls.at(-1)
              : byIndex.get(index);
          if (!call) {
            call = {
              id: tc.id || `call_${crypto.randomUUID()}`,
              name: "",
              args: "",
            };
            calls.push(call);
            if (index !== null) {
              byIndex.set(index, call);
            }
          }
          if (tc.function?.name && !call.name) {
            call.name = tc.function.name;
            input.emit({
              type: "tool_start",
              tool: {
                id: call.id,
                name: call.name,
                label: toolLabel(call.name, undefined),
              },
            });
          }
          if (tc.function?.arguments) {
            call.args += tc.function.arguments;
          }
        }
        if (choice?.finish_reason) {
          finish = choice.finish_reason;
        }
      }
      showReasoning();
      break;
    } catch (err) {
      if (input.signal?.aborted) {
        await lost("aborted");
        return null;
      }
      const info = parseWorkersAiError(err);
      // Busy: wait and ask again, as long as nothing of this call has streamed.
      if (!started && isRetryable(info) && attempt < retryDelays.length) {
        const ms = retryDelays[attempt]!;
        console.log(
          JSON.stringify({
            agent: "workers-ai retry",
            model: requested,
            attempt: attempt + 1,
            code: info.code,
            status: info.status,
          })
        );
        input.emit({
          type: "progress",
          text: `Workers AI is busy; asking again in ${Math.round(ms / 1000)} s.`,
        });
        if (!(await wait(ms, input.signal))) {
          return null;
        }
        continue;
      }
      await lost("error");
      if (info.code === null && !isRetryable(info)) {
        throw err;
      }
      throw new WorkersAiError(workersAiErrorText(info, attempt + 1), info, {
        cause: err,
      });
    }
  }
  if (input.signal?.aborted) {
    await lost("aborted");
    return null;
  }
  await saved;

  const content: WorkersAiAssistant = { content: text || null };
  if (calls.length) {
    content.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));
  }
  if (reasoning.trim()) {
    content.reasoning_content = reasoning;
  }
  const raw = usageSoFar();
  const usage = summarizeWorkersAiUsage(raw, model);
  const stop = STOPS[finish ?? ""] ?? "other";
  const result: StepResult = {
    assistant: {
      content,
      model,
      stopReason: finish,
      usage: raw,
      costUsd: usage.costUsd,
    },
    calls: calls.map((c) => parseCall(c.id, c.name, c.args)),
    stop,
    stopReason: finish,
    usage,
  };
  if (stop === "refusal") {
    result.refusal = { category: finish, explanation: null };
  }
  return result;
}
