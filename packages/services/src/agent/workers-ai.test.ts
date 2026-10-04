// biome-ignore-all lint/performance/noAwaitInLoops: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useErrorCause: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";
import {
  summarizeWorkersAiUsage,
  usageSummaryOf,
  WORKERS_AI_USD_PER_NEURON,
} from "@repo/cms-core/agent/cost";
import {
  type AgentModelOption,
  DEFAULT_AGENT_MODELS,
  modelOffInfo,
  validateModels,
} from "@repo/cms-core/agent/models";
import { apiTools, workersAiTools } from "@repo/cms-core/agent/tool-defs";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import { sampleDoc, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import type { PageRow } from "../cms/repo";
import type { Hydrate } from "./anthropic";
import { loadBudget } from "./budget";
import { danglingToolUses, runTurn } from "./loop";
import { createMemoryAgentStore } from "./memory-store";
import type { ModelProvider, StepResult } from "./provider";
import type { StoredMessage } from "./store-port";
import { canContinue, threadStats } from "./thread-limits";
import { threadDetail } from "./thread-view";
import type { ToolDeps } from "./tools";
import { contextTokensOf } from "./transcript";
import {
  type AiBinding,
  GIF_IMAGE,
  MAX_COMPLETION_TOKENS,
  maxCompletionTokens,
  OMITTED_IMAGE,
  parseWorkersAiError,
  sseJson,
  toWorkersAiMessages,
  workersAiErrorText,
  workersAiProvider,
} from "./workers-ai";

const GLM = "@cf/zai-org/glm-5.3-flash";

// ---------------------------------------------------------------------------------------------
// Fakes

function page(): PageRow {
  return {
    id: "p1",
    kind: "page",
    slug: "services/sample",
    title: "Sample",
    status: "draft",
    draftDoc: sampleDoc(),
    draftVersion: 3,
    draftBaseRevId: null,
    liveRevId: null,
    lastBatchId: null,
    updatedAt: new Date(0),
  };
}

function toolDeps(store = createMemoryAgentStore()): ToolDeps {
  const p = page();
  const unused = async () => {
    throw new Error("not used");
  };
  return {
    config: TEST_CONFIG,
    store,
    pageBySlug: async (slug) => (slug === p.slug ? p : null),
    pageById: async (id) => (id === p.id ? p : null),
    liveDoc: async () => null,
    listPages: async () => [p],
    draftPages: async () => [
      {
        id: p.id,
        kind: p.kind,
        slug: p.slug,
        title: p.title,
        status: p.status,
        doc: p.draftDoc!,
      },
    ],
    siteSeo: unused,
    mediaSizes: async () => ({}),
    searchMedia: async () => [],
    getMedia: async () => null,
    pagePerformance: unused,
    gscOverview: unused,
    renderPreview: async () => new Uint8Array([0xff, 0xd8, 0xff]),
    shareImage: unused,
    putScreenshot: async (threadId) => `r2:agent/screens/${threadId}/x.jpg`,
    previewLink: async ({ page: target, changesetId }) => ({
      url: `https://test.local/${target.slug}?_preview=t${changesetId ? `&cs=${changesetId}` : ""}`,
      expiresAt: "2026-10-03T01:00:00.000Z",
    }),
    createDraft: unused,
  };
}

/** Like the production hydrator: image refs become base64 image blocks. */
const hydrate: Hydrate = async (content) => {
  if (!Array.isArray(content)) {
    return content as never;
  }
  return content.map(
    (b: {
      type?: string;
      source?: { type?: string; ref?: string; media_type?: string };
    }) =>
      b.type === "image" && b.source?.type === "ref"
        ? {
            type: "image",
            source: {
              type: "base64",
              media_type: b.source.media_type,
              data: `B64(${b.source.ref})`,
            },
          }
        : b
  ) as never;
};

type Scripted = {
  reasoning?: string;
  text?: string;
  calls?: { id: string; name: string; args: string }[];
  finish: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; cached?: number };
  /** Leave the stream open after the content (for Stop). */
  hang?: boolean;
  /** Fail the stream with this error after the content (an error once bytes have streamed). */
  failWith?: string;
};

const usageOf = (u: NonNullable<Scripted["usage"]>) => ({
  prompt_tokens: u.prompt_tokens,
  completion_tokens: u.completion_tokens,
  prompt_tokens_details: { cached_tokens: u.cached ?? 0 },
  neurons: 1,
});

/** The chunks Workers AI streams for one response, as observed from GLM-5.3 Flash. */
function chunks(s: Scripted): unknown[] {
  const u = s.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
  const out: unknown[] = [
    {
      choices: [
        {
          delta: { content: "", reasoning_content: null, role: "assistant" },
          finish_reason: null,
          index: 0,
        },
      ],
      model: GLM,
      usage: { ...usageOf({ ...u, completion_tokens: 0 }) },
    },
  ];
  const delta = (d: Record<string, unknown>, completion = 1) =>
    out.push({
      choices: [{ delta: d, finish_reason: null, index: 0 }],
      model: GLM,
      usage: { prompt_tokens: 0, completion_tokens: completion, neurons: 0 },
    });
  if (s.reasoning) {
    const half = Math.ceil(s.reasoning.length / 2);
    delta({ reasoning_content: s.reasoning.slice(0, half) });
    delta({ reasoning_content: s.reasoning.slice(half) });
  }
  if (s.text) {
    delta({ content: s.text });
  }
  (s.calls ?? []).forEach((c, index) => {
    delta({
      content: null,
      tool_calls: [
        {
          index,
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: "" },
        },
      ],
    });
    const half = Math.ceil(c.args.length / 2);
    delta(
      {
        tool_calls: [
          {
            index,
            id: null,
            function: { name: null, arguments: c.args.slice(0, half) },
          },
        ],
      },
      0
    );
    delta(
      {
        tool_calls: [
          {
            index,
            id: null,
            function: { name: null, arguments: c.args.slice(half) },
          },
        ],
      },
      0
    );
  });
  if (s.hang) {
    return out;
  }
  out.push({
    choices: [{ delta: {}, finish_reason: s.finish, index: 0 }],
    model: GLM,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });
  out.push({ response: "", usage: usageOf(u) });
  return out;
}

/** SSE bytes cut into small pieces, so lines arrive split across reads. */
function sseStream(
  s: Scripted,
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  let text = chunks(s)
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("");
  if (!(s.hang || s.failWith)) {
    text += "data: [DONE]\n\n";
  }
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < bytes.length) {
        controller.enqueue(bytes.slice(i, i + 37));
        i += 37;
      } else if (s.failWith) {
        controller.error(new Error(s.failWith));
      } else if (s.hang) {
        return new Promise(() => {}); // Open until cancelled.
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** The binding's error for a replayed tool call whose arguments aren't JSON, as the real API returns it. */
const INVALID_ARGS =
  '8007: {"message":"Assistant tool call function.arguments must be valid JSON.","code":400}';
const BUSY =
  '3040: {"message":"Capacity temporarily exceeded, please try again.","code":429}';

/**
 * Answers with the scripted responses in order (an Error entry is thrown by `run`, like an API
 * error) and records every request. Like the real API, refuses a request that replays a tool call
 * whose arguments aren't valid JSON.
 */
function fakeAi(
  script: (Scripted | Error)[],
  opts: { onFirstRead?: () => void } = {}
) {
  const requests: { model: string; inputs: Record<string, unknown> }[] = [];
  const live: Record<string, unknown>[] = [];
  let cancelled = 0;
  const ai: AiBinding = {
    async run(model, inputs) {
      requests.push({ model, inputs: structuredClone(inputs) });
      live.push(inputs);
      for (const m of inputs.messages as Msg[]) {
        for (const c of (m.tool_calls as
          | { function: { arguments: string } }[]
          | undefined) ?? []) {
          try {
            JSON.parse(c.function.arguments);
          } catch {
            throw new Error(INVALID_ARGS);
          }
        }
      }
      const s = script.shift();
      if (!s) {
        throw new Error("no more scripted responses");
      }
      if (s instanceof Error) {
        throw s;
      }
      opts.onFirstRead?.();
      return sseStream(s, () => cancelled++);
    },
  };
  return { ai, requests, live, cancelled: () => cancelled };
}

/** Every tool call a request replays, with its arguments parsed. */
const replayedArgs = (req: { inputs: Record<string, unknown> }) =>
  messagesOf(req).flatMap((m) =>
    (
      (m.tool_calls as { function: { arguments: string } }[] | undefined) ?? []
    ).map((c) => JSON.parse(c.function.arguments) as unknown)
  );

async function thread(store = createMemoryAgentStore()) {
  await store.createThread({
    id: "t1",
    pageId: "p1",
    title: "x",
    author: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    provider: "workers-ai",
    model: GLM,
  });
  return store;
}

type Msg = {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};
const messagesOf = (req: { inputs: Record<string, unknown> }) =>
  req.inputs.messages as Msg[];

// ---------------------------------------------------------------------------------------------

describe("Workers AI tools", () => {
  it("are the same tools in the function-calling format, without Anthropic-only fields", () => {
    const fns = workersAiTools();
    const api = apiTools();
    expect(fns.map((t) => t.function.name)).toEqual(api.map((t) => t.name));
    fns.forEach((t, i) => {
      expect(t.type).toBe("function");
      expect(t.function.description).toBe(api[i]!.description);
      expect(t.function.parameters).toEqual(api[i]!.input_schema);
      expect(t.function.parameters.type).toBe("object");
      expect(JSON.stringify(t)).not.toMatch(/eager_input_streaming|"strict"/);
    });
    expect(JSON.stringify(workersAiTools())).toBe(JSON.stringify(fns));
  });
});

describe("Workers AI provider in the agent loop", () => {
  it("round-trips a tool call: streamed text, reasoning and split arguments; tool rows; reasoning not sent back", async () => {
    const store = await thread();
    const { ai, requests } = fakeAi([
      {
        reasoning: "I should read the page first.",
        text: "Reading the page.",
        calls: [
          {
            id: "call_1",
            name: "get_page",
            args: '{"slug": "services/sample", "mode": "outline"}',
          },
        ],
        finish: "tool_calls",
      },
      { text: "The hero leads with the offer.", finish: "stop" },
    ]);
    const events: AgentEvent[] = [];
    const provider = workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG);
    const res = await runTurn(
      {
        provider,
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
      },
      { threadId: "t1", pageId: "p1", user: "Hello", context: "Context 1" }
    );
    expect(res.stopReason).toBe("stop");

    // Requests: GLM via the binding, streamed, with the function tools and the model's reasoning effort.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.model).toBe(GLM);
    expect(requests[0]!.inputs).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      reasoning_effort: "high",
      max_completion_tokens: expect.any(Number),
    });
    expect(requests[0]!.inputs.tools).toEqual(workersAiTools());
    const first = messagesOf(requests[0]!);
    expect(first[0]!.role).toBe("system");
    expect(first.slice(1)).toEqual([
      { role: "user", content: "Hello" },
      { role: "system", content: "Context 1" },
    ]);
    const second = messagesOf(requests[1]!);
    expect(second.slice(0, 3)).toEqual(first);
    expect(second[3]).toEqual({
      role: "assistant",
      content: "Reading the page.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_page",
            arguments: '{"slug": "services/sample", "mode": "outline"}',
          },
        },
      ],
    });
    expect(second[4]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(JSON.parse(second[4]!.content as string)).toMatchObject({
      slug: "services/sample",
    });
    expect(JSON.stringify(second)).not.toContain(
      "I should read the page first."
    );

    // Stored in the thread's own format: tool results are `tool` rows; reasoning is kept for the chat.
    const stored = await store.messages("t1");
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stored[2]!.content).toMatchObject({
      content: "Reading the page.",
      reasoning_content: "I should read the page first.",
    });
    expect(stored[3]!.content).toMatchObject({ tool_call_id: "call_1" });
    expect(stored[4]).toMatchObject({ model: GLM, stopReason: "stop" });

    // Chat events: reasoning as a collapsed note, text, the tool chip.
    expect(events).toContainEqual({
      type: "progress",
      text: "I should read the page first.",
      reasoning: true,
    });
    expect(events).toContainEqual({ type: "text", text: "Reading the page." });
    expect(
      events
        .filter((e) => e.type === "tool_start")
        .map((e) => (e as { tool: { id: string } }).tool.id)
    ).toEqual(["call_1", "call_1"]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_end", id: "call_1", ok: true })
    );
    expect(events.filter((e) => e.type === "call_start")).toHaveLength(2);
  });

  it("sends tool images (render_preview) as image_url data URLs in a user message after the tool messages", async () => {
    const store = await thread();
    const { ai, requests } = fakeAi([
      {
        calls: [
          {
            id: "call_r",
            name: "render_preview",
            args: '{"slug":"services/sample","device":"mobile"}',
          },
        ],
        finish: "tool_calls",
      },
      {
        text: "The hero heading wraps onto three lines on mobile.",
        finish: "stop",
      },
    ]);
    await runTurn(
      {
        provider: workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      { threadId: "t1", pageId: "p1", user: "Check mobile", context: "c" }
    );
    const msgs = messagesOf(requests[1]!);
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(tool.content).toMatch(
      /Rendered the saved draft at mobile width\.\n\(The image is in the next message\.\)/
    );
    expect(msgs.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Images returned by the tool calls above.]" },
        { type: "text", text: "Image from tool call call_r:" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/jpeg;base64,B64(r2:agent/screens/t1/x.jpg)",
          },
        },
      ],
    });
    // Stored as a reference (read from R2 when a request is built), counted toward the thread's image cap.
    const stored = await store.messages("t1");
    expect(JSON.stringify(stored[3]!.content)).toContain(
      '"ref":"r2:agent/screens/t1/x.jpg"'
    );
    expect(threadStats(stored).images).toBe(1);
  });

  it("user images go as image_url parts; only text stays a plain string", async () => {
    const rows: StoredMessage[] = [
      {
        seq: 0,
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "ref", ref: "media:m1", media_type: "image/png" },
          },
          { type: "text", text: "Use this" },
        ],
        createdAt: new Date(0),
      },
      {
        seq: 1,
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        createdAt: new Date(0),
      },
    ];
    expect(await toWorkersAiMessages(rows, hydrate)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,B64(media:m1)" },
          },
          { type: "text", text: "Use this" },
        ],
      },
      { role: "user", content: "a\nb" },
    ]);
  });

  it("maps stop reasons: length ends with a notice, content_filter is a refusal, tool calls after a non-tool stop don't run", async () => {
    const run = async (s: Scripted) => {
      const store = await thread();
      const events: AgentEvent[] = [];
      const { ai } = fakeAi([s]);
      const res = await runTurn(
        {
          provider: workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG),
          store,
          tools: toolDeps(store),
          emit: (e) => events.push(e),
        },
        { threadId: "t1", pageId: "p1", user: "x", context: "c" }
      );
      return { res, events, stored: await store.messages("t1") };
    };
    const long = await run({ text: "Cut", finish: "length" });
    expect(long.events).toContainEqual({
      type: "notice",
      text: "The reply hit the output limit and may be cut off.",
    });
    const filtered = await run({ text: "", finish: "content_filter" });
    expect(filtered.events).toContainEqual({
      type: "refusal",
      category: "content_filter",
      explanation: null,
    });
    const odd = await run({
      calls: [{ id: "c1", name: "list_pages", args: "{}" }],
      finish: "stop",
    });
    expect(odd.events.some((e) => e.type === "tool_end")).toBe(false);
    expect(odd.stored.at(-1)).toMatchObject({
      role: "tool",
      content: {
        tool_call_id: "c1",
        is_error: true,
        content: 'Not run: the response ended with "stop".',
      },
    });
    expect(danglingToolUses(odd.stored)).toEqual([]);
  });

  it("arguments that aren't JSON are answered with an error the model can fix, without running the tool", async () => {
    const store = await thread();
    const { ai, requests } = fakeAi([
      {
        calls: [
          {
            id: "c1",
            name: "get_page",
            args: '{"slug": "services/sample", "mode": ',
          },
        ],
        finish: "tool_calls",
      },
      { text: "Fixed.", finish: "stop" },
    ]);
    const events: AgentEvent[] = [];
    await runTurn(
      {
        provider: workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
      },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    const tool = messagesOf(requests[1]!).find((m) => m.role === "tool")!;
    expect(tool.content).toMatch(/^Error: .*INVALID_INPUT.*weren't valid JSON/);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_end", id: "c1", ok: false })
    );
  });

  it("Stop before the first reply stores nothing, cancels the stream and records the spend so far", async () => {
    const store = await thread();
    const abort = new AbortController();
    const { ai, cancelled } = fakeAi([
      {
        reasoning: "Thinking about it",
        hang: true,
        finish: null,
        usage: { prompt_tokens: 50_000, completion_tokens: 0 },
      },
    ]);
    const slow: AiBinding = {
      async run(model, inputs, options) {
        const stream = (await ai.run(
          model,
          inputs,
          options
        )) as ReadableStream<Uint8Array>;
        setTimeout(() => abort.abort(), 5);
        return stream;
      },
    };
    const events: AgentEvent[] = [];
    const res = await runTurn(
      {
        provider: workersAiProvider(slow, GLM, () => hydrate, TEST_CONFIG),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
        signal: abort.signal,
      },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(res.stopReason).toBe("aborted");
    expect(await store.messages("t1")).toEqual([]);
    expect(cancelled()).toBe(1);
    expect(store.rows.usage).toHaveLength(1);
    expect(store.rows.usage[0]).toMatchObject({ kind: "aborted", model: GLM });
    // The streamed chunks so far: 50K prompt tokens at $0.15/M and two reasoning tokens at $0.50/M.
    expect(store.rows.usage[0]!.costUsd).toBeCloseTo(0.007_501, 6);
    expect(
      (await loadBudget(store, "t1", Date.now())).thread?.spentUsd
    ).toBeCloseTo(0.007_501, 6);
  });

  it("an interrupted request's tool calls get tool rows before the next message, and a turn paused after tools can continue", async () => {
    const store = await thread();
    await store.append("t1", [
      { seq: 0, role: "user", content: "x", createdAt: new Date(0) },
      {
        seq: 1,
        role: "assistant",
        content: {
          content: null,
          tool_calls: [
            {
              id: "c9",
              type: "function",
              function: { name: "list_pages", arguments: "{}" },
            },
          ],
        },
        createdAt: new Date(0),
      },
    ]);
    expect(danglingToolUses(await store.messages("t1"))).toEqual(["c9"]);
    const { ai, requests } = fakeAi([{ text: "ok", finish: "stop" }]);
    await runTurn(
      {
        provider: workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      { threadId: "t1", pageId: "p1", user: "again", context: "c" }
    );
    expect(messagesOf(requests[0]!).slice(3, 5)).toEqual([
      {
        role: "tool",
        tool_call_id: "c9",
        content: "Error: Interrupted before it ran.",
      },
      { role: "user", content: "again" },
    ]);
    const stored = await store.messages("t1");
    expect(canContinue(stored.slice(0, 3))).toBe(true);
    expect(canContinue(stored)).toBe(false);
  });
});

describe("the provider boundary (a fake provider)", () => {
  function fakeProvider(steps: (StepResult | null | Error)[]) {
    const seen: StoredMessage[][] = [];
    const provider: ModelProvider = {
      id: "workers-ai",
      model: "fake",
      async step(input) {
        seen.push(structuredClone(input.rows));
        const next = steps.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next ?? null;
      },
      toolResultRows: (results) =>
        results.map((r) => ({
          role: "tool",
          content: {
            tool_call_id: r.id,
            content: r.content,
            ...(r.isError && { is_error: true }),
          },
        })),
    };
    return { provider, seen };
  }
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  };
  const step = (
    calls: StepResult["calls"],
    stop: StepResult["stop"]
  ): StepResult => ({
    assistant: {
      content: {
        content: "x",
        ...(calls.length && {
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        }),
      },
      model: "fake",
      stopReason: stop,
      usage: {},
      costUsd: 0.01,
    },
    calls,
    stop,
    stopReason: stop,
    usage,
  });

  it("runs tools between steps and passes the provider the whole transcript", async () => {
    const store = await thread();
    const { provider, seen } = fakeProvider([
      step([{ id: "a", name: "list_pages", input: {} }], "tool_use"),
      step([], "end"),
    ]);
    await runTurn(
      { provider, store, tools: toolDeps(store), emit: () => {} },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(seen.map((rows) => rows.map((r) => r.role))).toEqual([
      ["user", "system"],
      ["user", "system", "assistant", "tool"],
    ]);
    expect(await store.threadCost("t1")).toBeCloseTo(0.02, 6);
  });

  it("a stopped or failed first step stores nothing; a later step keeps what ran", async () => {
    for (const outcome of [null, new Error("boom")]) {
      const store = await thread();
      const { provider } = fakeProvider([outcome]);
      const run = runTurn(
        { provider, store, tools: toolDeps(store), emit: () => {} },
        { threadId: "t1", pageId: "p1", user: "x", context: "c" }
      );
      if (outcome) {
        await expect(run).rejects.toThrow("boom");
      } else {
        expect((await run).stopReason).toBe("aborted");
      }
      expect(await store.messages("t1")).toEqual([]);
      expect(await store.deleteThreadIfEmpty("t1")).toBe(true);
    }
    const store = await thread();
    const { provider } = fakeProvider([
      step([{ id: "a", name: "list_pages", input: {} }], "tool_use"),
      null,
    ]);
    await runTurn(
      { provider, store, tools: toolDeps(store), emit: () => {} },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect((await store.messages("t1")).map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
    ]);
  });
});

describe("Workers AI usage and cost", () => {
  it("prices GLM-5.3 Flash per token: cached tokens are part of the prompt and bill at the cached rate", () => {
    const u = summarizeWorkersAiUsage(
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        prompt_tokens_details: { cached_tokens: 400_000 },
      },
      GLM
    );
    expect(u).toEqual({
      inputTokens: 600_000,
      cacheReadTokens: 400_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 0,
      costUsd: 0.6 * 0.15 + 0.4 * 0.03 + 0.5,
    });
    expect(
      summarizeWorkersAiUsage(
        { prompt_tokens: 188, completion_tokens: 19, neurons: 3.427 },
        GLM
      ).costUsd
    ).toBeCloseTo((188 * 0.15 + 19 * 0.5) / 1e6, 6);
  });

  it("prices a Workers AI model without a table entry from its neurons", () => {
    expect(
      summarizeWorkersAiUsage(
        { prompt_tokens: 10, completion_tokens: 10, neurons: 1000 },
        "@cf/acme/other"
      ).costUsd
    ).toBeCloseTo(1000 * WORKERS_AI_USD_PER_NEURON, 9);
    expect(
      usageSummaryOf(
        { prompt_tokens: 10, completion_tokens: 10, neurons: 1000 },
        "@cf/acme/other"
      ).costUsd
    ).toBeCloseTo(0.011, 9);
    // Anthropic usage still goes through the Claude prices.
    expect(
      usageSummaryOf({ input_tokens: 1_000_000 }, "claude-opus-5-5").costUsd
    ).toBe(4);
  });

  it("thread stats read Workers AI usage for the context-size limit", () => {
    const rows: StoredMessage[] = [
      { seq: 0, role: "user", content: "x", createdAt: new Date(0) },
      {
        seq: 1,
        role: "assistant",
        content: { content: "y" },
        usage: { prompt_tokens: 650_000, completion_tokens: 10 },
        createdAt: new Date(0),
      },
    ];
    expect(threadStats(rows)).toEqual({
      turns: 1,
      images: 0,
      contextTokens: 650_010,
    });
  });
});

describe("Workers AI threads in the chat", () => {
  it("show reasoning collapsed, text, tool chips with results, the thread's model, and no fallback badge", async () => {
    const store = await thread();
    const { ai } = fakeAi([
      {
        reasoning: "Plan: read it.",
        calls: [
          {
            id: "call_1",
            name: "get_page",
            args: '{"slug":"services/sample","mode":"outline"}',
          },
        ],
        finish: "tool_calls",
      },
      {
        text: "Done.",
        finish: "stop",
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      },
    ]);
    await runTurn(
      {
        provider: workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      { threadId: "t1", pageId: "p1", user: "Hi", context: "c" }
    );
    const t = (await store.getThread("t1"))!;
    const budget = await loadBudget(store, "t1", Date.now());
    const detail = threadDetail(t, await store.messages("t1"), [], budget);
    expect(detail.thread).toMatchObject({ provider: "workers-ai", model: GLM });
    expect(detail.items.map((i) => i.kind)).toEqual([
      "user",
      "progress",
      "tool",
      "text",
    ]);
    expect(detail.items[1]).toMatchObject({
      kind: "progress",
      reasoning: true,
      text: "Plan: read it.",
    });
    expect(detail.items[2]).toMatchObject({
      kind: "tool",
      id: "call_1",
      ok: true,
      label: "Reading /services/sample",
    });
    expect(detail.items[3]).toMatchObject({
      kind: "text",
      text: "Done.",
      model: GLM,
    });
    expect(detail.items[3]).not.toHaveProperty("fallback");
    expect(detail.usage.inputTokens).toBe(1100);
    expect(detail.thread.costUsd).toBeCloseTo(
      summarizeWorkersAiUsage(
        { prompt_tokens: 1100, completion_tokens: 120 },
        GLM
      ).costUsd,
      6
    );
    expect((await store.listThreads("p1"))[0]).toMatchObject({
      provider: "workers-ai",
      model: GLM,
    });
  });

  it("threads created before the model choice are Claude threads", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "old",
      pageId: "p1",
      title: "x",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    expect((await store.listThreads("p1"))[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });
});

describe("agent model list", () => {
  it("accepts the defaults and Workers AI ids; rejects bad ids, other Anthropic models, duplicates and an all-disabled list", () => {
    expect(validateModels(DEFAULT_AGENT_MODELS)).toEqual({
      ok: true,
      models: DEFAULT_AGENT_MODELS,
    });
    const extra = {
      provider: "workers-ai",
      id: "@cf/moonshotai/kimi-k2.7-code",
      label: "Kimi",
      enabled: false,
    };
    expect(validateModels([...DEFAULT_AGENT_MODELS, extra]).ok).toBe(true);
    expect(validateModels([{ ...extra, id: "kimi-k2" }])).toMatchObject({
      ok: false,
      message: expect.stringContaining("@cf/"),
    });
    expect(validateModels([{ ...extra, id: "@hf/org/model" }]).ok).toBe(false);
    expect(
      validateModels([
        {
          provider: "anthropic",
          id: "claude-sonnet-5-5",
          label: "Sonnet",
          enabled: true,
        },
      ]).ok
    ).toBe(false);
    expect(
      validateModels([DEFAULT_AGENT_MODELS[0], DEFAULT_AGENT_MODELS[0]]).ok
    ).toBe(false);
    expect(
      validateModels(
        DEFAULT_AGENT_MODELS.map((m) => ({ ...m, enabled: false }))
      )
    ).toEqual({ ok: false, message: "Enable at least one model." });
    expect(validateModels([{ ...extra, enabled: true, label: " " }]).ok).toBe(
      false
    );
    expect(validateModels([]).ok).toBe(false);
  });

  it("saving models keeps the default spending caps when there was no settings row", async () => {
    const store = createMemoryAgentStore();
    await store.saveModels(DEFAULT_AGENT_MODELS, null, new Date(0));
    expect(await store.getSettings()).toEqual({
      threadCapUsd: 3,
      dailyCapUsd: 20,
    });
    expect(await store.getModels()).toEqual(DEFAULT_AGENT_MODELS);
  });
});

describe("SSE parsing", () => {
  it("reads data lines split across chunks and stops at [DONE]", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"a":1}\n\n: comment\ndata: {"b":\n\ndata: {"c":2}\n\ndata: [DONE]\n\ndata: {"d":3}\n\n'
    );
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 5) {
          c.enqueue(bytes.slice(i, i + 5));
        }
        c.close();
      },
    });
    const out: unknown[] = [];
    for await (const e of sseJson(stream)) {
      out.push(e);
    }
    expect(out).toEqual([{ a: 1 }, { c: 2 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes

const turn = (
  ai: AiBinding,
  store: ReturnType<typeof createMemoryAgentStore>,
  user: string,
  extra: {
    events?: AgentEvent[];
    signal?: AbortSignal;
    retryDelaysMs?: number[];
  } = {}
) =>
  runTurn(
    {
      provider: workersAiProvider(ai, GLM, () => hydrate, TEST_CONFIG, {
        retryDelaysMs: extra.retryDelaysMs ?? [1, 1, 1],
      }),
      store,
      tools: toolDeps(store),
      emit: (e) => extra.events?.push(e),
      signal: extra.signal,
    },
    { threadId: "t1", pageId: "p1", user, context: "c" }
  );

describe("replayed tool calls always have valid JSON arguments (H1)", () => {
  it("a reply cut off mid tool call (finish_reason length) doesn't brick the thread; the stored row keeps what the model sent", async () => {
    const store = await thread();
    const { ai, requests } = fakeAi([
      {
        text: "Proposing.",
        calls: [
          {
            id: "c1",
            name: "propose_ops",
            args: '{"summary": "Hero for CFOs", "ops": [{"op": "set", "key": "he',
          },
        ],
        finish: "length",
      },
      { text: "Here is the shorter version.", finish: "stop" },
    ]);
    const events: AgentEvent[] = [];
    expect(
      (await turn(ai, store, "Rewrite the hero", { events })).stopReason
    ).toBe("length");
    expect(events).toContainEqual({
      type: "notice",
      text: "The reply hit the output limit and may be cut off.",
    });
    const stored = await store.messages("t1");
    expect(
      (
        stored[2]!.content as {
          tool_calls: { function: { arguments: string } }[];
        }
      ).tool_calls[0]!.function.arguments
    ).toBe('{"summary": "Hero for CFOs", "ops": [{"op": "set", "key": "he');

    // The next turn replays it: the request is accepted (the fake refuses invalid arguments like the API).
    expect((await turn(ai, store, "Try again, shorter")).stopReason).toBe(
      "stop"
    );
    expect(requests).toHaveLength(2);
    expect(replayedArgs(requests[1]!)).toEqual([{}]);
    const replayed = messagesOf(requests[1]!).find(
      (m) => m.role === "assistant"
    )!;
    expect(replayed).toMatchObject({
      content: "Proposing.",
      tool_calls: [
        { id: "c1", function: { name: "propose_ops", arguments: "{}" } },
      ],
    });
    expect(
      messagesOf(requests[1]!).find((m) => m.role === "tool")
    ).toMatchObject({
      tool_call_id: "c1",
      content: expect.stringContaining("Not run"),
    });
  });

  it("heals a thread stored before the fix (invalid and empty arguments, null content); valid arguments pass through byte for byte", async () => {
    const store = await thread();
    const valid = '{"slug":  "services/sample"}';
    await store.append("t1", [
      { seq: 0, role: "user", content: "x", createdAt: new Date(0) },
      {
        seq: 1,
        role: "assistant",
        content: {
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "get_page", arguments: '{"slug": "serv' },
            },
            {
              id: "b",
              type: "function",
              function: { name: "list_pages", arguments: "" },
            },
            {
              id: "c",
              type: "function",
              function: { name: "get_page", arguments: valid },
            },
          ],
        },
        createdAt: new Date(0),
      },
      ...["a", "b", "c"].map((id, i) => ({
        seq: 2 + i,
        role: "tool" as const,
        content: { tool_call_id: id, content: "Error", is_error: true },
        createdAt: new Date(0),
      })),
      {
        seq: 5,
        role: "assistant",
        content: { content: null },
        createdAt: new Date(0),
      },
    ]);
    const { ai, requests } = fakeAi([{ text: "ok", finish: "stop" }]);
    expect((await turn(ai, store, "again")).stopReason).toBe("stop");
    const msgs = messagesOf(requests[0]!);
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.content)).toEqual(["", ""]);
    expect(
      (assistants[0]!.tool_calls as { function: { arguments: string } }[]).map(
        (c) => c.function.arguments
      )
    ).toEqual(["{}", "{}", valid]);
    // Every replayed tool call parses.
    for (const req of requests) {
      expect(() => replayedArgs(req)).not.toThrow();
    }
  });
});

describe("busy Workers AI and errors (M1)", () => {
  it("retries out-of-capacity errors before anything streamed, then answers", async () => {
    const store = await thread();
    const { ai, requests } = fakeAi([
      new Error(BUSY),
      new Error("429: Too Many Requests"),
      { text: "Done.", finish: "stop" },
    ]);
    const events: AgentEvent[] = [];
    expect((await turn(ai, store, "x", { events })).stopReason).toBe("stop");
    expect(requests).toHaveLength(3);
    expect(
      events
        .filter((e) => e.type === "progress")
        .map((e) => (e as { text: string }).text)
    ).toEqual([
      "Workers AI is busy; asking again in 0 s.",
      "Workers AI is busy; asking again in 0 s.",
    ]);
    expect((await store.messages("t1")).map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
    ]);
  });

  it("gives up after three retries with plain text, and doesn't retry other errors", async () => {
    const store = await thread();
    const busy = fakeAi([
      new Error(BUSY),
      new Error(BUSY),
      new Error(BUSY),
      new Error(BUSY),
    ]);
    await expect(turn(busy.ai, store, "x")).rejects.toThrow(
      "Workers AI is busy right now (tried 4 times). Try again in a minute."
    );
    expect(busy.requests).toHaveLength(4);
    const bad = fakeAi([new Error(INVALID_ARGS)]);
    await expect(turn(bad.ai, store, "x")).rejects.toThrow(
      /^Workers AI refused the request \(error 8007\): Assistant tool call function\.arguments must be valid JSON\.$/
    );
    expect(bad.requests).toHaveLength(1);
    // The daily free allocation doesn't come back in seconds.
    const limited = fakeAi([
      new Error(
        '3036: {"message":"You have used up your daily free allocation of 10,000 neurons.","code":429}'
      ),
    ]);
    await expect(turn(limited.ai, store, "x")).rejects.toThrow(
      /daily free allocation is used up/
    );
    expect(limited.requests).toHaveLength(1);
    expect(await store.messages("t1")).toEqual([]);
  });

  it("doesn't retry once bytes streamed; the spend so far is recorded as an error", async () => {
    const store = await thread();
    const { ai, requests } = fakeAi([
      {
        text: "Half a repl",
        finish: null,
        failWith: BUSY,
        usage: { prompt_tokens: 10_000, completion_tokens: 0 },
      },
    ]);
    await expect(turn(ai, store, "x")).rejects.toThrow(
      "Workers AI is busy right now."
    );
    expect(requests).toHaveLength(1);
    expect(store.rows.usage).toEqual([
      expect.objectContaining({ kind: "error", model: GLM }),
    ]);
  });

  it("Stop during the wait before a retry ends the turn without another request", async () => {
    const store = await thread();
    const abort = new AbortController();
    const { ai, requests } = fakeAi([
      new Error(BUSY),
      { text: "never", finish: "stop" },
    ]);
    const run = turn(ai, store, "x", {
      signal: abort.signal,
      retryDelaysMs: [60_000],
    });
    setTimeout(() => abort.abort(), 5);
    expect((await run).stopReason).toBe("aborted");
    expect(requests).toHaveLength(1);
    expect(await store.messages("t1")).toEqual([]);
  });

  it("parses the binding's error text", () => {
    expect(parseWorkersAiError(new Error(INVALID_ARGS))).toEqual({
      code: 8007,
      status: 400,
      message: "Assistant tool call function.arguments must be valid JSON.",
    });
    expect(
      parseWorkersAiError(new Error("3006: Request is too large"))
    ).toEqual({ code: 3006, status: null, message: "Request is too large" });
    expect(
      parseWorkersAiError(new Error("Binding AI needs to be run remotely"))
    ).toEqual({
      code: null,
      status: null,
      message: "Binding AI needs to be run remotely",
    });
    expect(
      workersAiErrorText(
        parseWorkersAiError(new Error("3006: Request is too large"))
      )
    ).toMatch(/too large for Workers AI\. Start a new thread/);
    expect(
      workersAiErrorText(parseWorkersAiError(new Error("5007: No such model")))
    ).toMatch(/Check its id in AI settings/);
  });
});

describe("spend of a streaming call is saved as it streams (M2)", () => {
  it("a call cut off mid-stream (the Worker ends) has its spend so far in agent_usage; Stop turns that row into the aborted one", async () => {
    const store = await thread();
    const abort = new AbortController();
    const { ai } = fakeAi([
      {
        reasoning: "Thinking about it",
        hang: true,
        finish: null,
        usage: { prompt_tokens: 50_000, completion_tokens: 0 },
      },
    ]);
    const run = turn(ai, store, "x", { signal: abort.signal });
    // While it streams (this is what's left if the Worker is killed now): one `streaming` row, counted in the thread's cost.
    await waitFor(() => expect(store.rows.usage).toHaveLength(1));
    expect(store.rows.usage[0]).toMatchObject({
      kind: "streaming",
      model: GLM,
      threadId: "t1",
    });
    // The first report: 50K prompt tokens at $0.15/M.
    expect(await store.threadCost("t1")).toBeCloseTo(0.0075, 6);
    expect(
      (await loadBudget(store, "t1", Date.now())).thread?.spentUsd
    ).toBeCloseTo(0.0075, 6);
    abort.abort();
    expect((await run).stopReason).toBe("aborted");
    expect(store.rows.usage).toHaveLength(1);
    expect(store.rows.usage[0]).toMatchObject({ kind: "aborted" });
    expect(store.rows.usage[0]!.costUsd).toBeCloseTo(0.007_501, 6);
  });

  it("a finished call's checkpoint is replaced by its stored message in the same write (no double count)", async () => {
    const store = await thread();
    const { ai } = fakeAi([
      {
        calls: [{ id: "c1", name: "list_pages", args: "{}" }],
        finish: "tool_calls",
        usage: { prompt_tokens: 10_000, completion_tokens: 50 },
      },
      {
        text: "Done.",
        finish: "stop",
        usage: { prompt_tokens: 11_000, completion_tokens: 20 },
      },
    ]);
    const checkpoints: string[] = [];
    const record = store.recordUsage.bind(store);
    store.recordUsage = async (row) => {
      checkpoints.push(row.kind);
      await record(row);
    };
    await turn(ai, store, "x");
    expect(checkpoints).toEqual(["streaming", "streaming"]);
    expect(store.rows.usage).toEqual([]);
    const stored = await store.messages("t1");
    expect(await store.threadCost("t1")).toBeCloseTo(
      stored.reduce((s, m) => s + (m.costUsd ?? 0), 0),
      9
    );
  });
});

describe("images per request (M3)", () => {
  const img = (ref: string, media_type = "image/jpeg") => ({
    type: "image",
    source: { type: "ref", ref, media_type },
  });
  /** A hydrator that records which refs it read. */
  const counting = () => {
    const read: string[] = [];
    const h: Hydrate = async (content) => {
      if (Array.isArray(content)) {
        for (const b of content as {
          type?: string;
          source?: { ref?: string };
        }[]) {
          if (b.type === "image" && b.source?.ref) {
            read.push(b.source.ref);
          }
        }
      }
      return hydrate(content);
    };
    return { h, read };
  };

  it("sends the latest 8 images; older ones (and GIFs) go as text and are never read", async () => {
    const rows: StoredMessage[] = [
      {
        seq: 0,
        role: "user",
        content: [
          img("media:u1"),
          img("media:u2"),
          img("media:g1", "image/gif"),
          { type: "text", text: "Look" },
        ],
        createdAt: new Date(0),
      },
      {
        seq: 1,
        role: "assistant",
        content: {
          content: null,
          tool_calls: [1, 2, 3, 4].map((i) => ({
            id: `r${i}`,
            type: "function",
            function: { name: "render_preview", arguments: "{}" },
          })),
        },
        createdAt: new Date(0),
      },
      ...[1, 2, 3, 4].map((i) => ({
        seq: 1 + i,
        role: "tool" as const,
        content: {
          tool_call_id: `r${i}`,
          content: [
            { type: "text", text: `Render ${i}` },
            img(`r2:s${i}a`),
            img(`r2:s${i}b`),
          ],
        },
        createdAt: new Date(0),
      })),
    ];
    const { h, read } = counting();
    const msgs = await toWorkersAiMessages(rows, h);
    const urls =
      JSON.stringify(msgs).match(/data:image\/[a-z]+;base64,B64\(([^)]+)\)/g) ??
      [];
    expect(urls).toHaveLength(8);
    expect(read).toEqual([
      "r2:s1a",
      "r2:s1b",
      "r2:s2a",
      "r2:s2b",
      "r2:s3a",
      "r2:s3b",
      "r2:s4a",
      "r2:s4b",
    ]);
    expect(msgs[0]).toEqual({
      role: "user",
      content: `${OMITTED_IMAGE}\n${OMITTED_IMAGE}\n${GIF_IMAGE}\nLook`,
    });
    // The stored rows are untouched.
    expect(
      (rows[0]!.content as unknown[]).filter(
        (b) => (b as { type: string }).type === "image"
      )
    ).toHaveLength(3);
  });

  it("a tool row whose images were all omitted doesn't point to an image message", async () => {
    const rows: StoredMessage[] = [
      {
        seq: 0,
        role: "assistant",
        content: {
          content: null,
          tool_calls: [
            {
              id: "r1",
              type: "function",
              function: { name: "render_preview", arguments: "{}" },
            },
          ],
        },
        createdAt: new Date(0),
      },
      {
        seq: 1,
        role: "tool",
        content: {
          tool_call_id: "r1",
          content: [{ type: "text", text: "Rendered." }, img("r2:x")],
        },
        createdAt: new Date(0),
      },
      {
        seq: 2,
        role: "user",
        content: [img("media:new"), { type: "text", text: "This one" }],
        createdAt: new Date(0),
      },
    ];
    const msgs = await toWorkersAiMessages(rows, hydrate, 1);
    expect(msgs[1]).toEqual({
      role: "tool",
      tool_call_id: "r1",
      content: `Rendered.\n${OMITTED_IMAGE}`,
    });
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toMatchObject({
      role: "user",
      content: [{ type: "image_url" }, { type: "text", text: "This one" }],
    });
  });

  it("the request drops its messages once the stream starts (a retry before that still has them)", async () => {
    const store = await thread();
    const { ai, requests, live } = fakeAi([
      new Error(BUSY),
      { text: "ok", finish: "stop" },
    ]);
    await turn(ai, store, "x");
    expect(messagesOf(requests[1]!).length).toBeGreaterThan(1);
    expect(live[1]).not.toHaveProperty("messages");
  });
});

describe("a thread whose model is turned off (M4)", () => {
  const opts = (glm: Partial<AgentModelOption>): AgentModelOption[] => [
    {
      provider: "anthropic",
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      enabled: true,
      available: true,
    },
    {
      provider: "workers-ai",
      id: GLM,
      label: "GLM-5.3 Flash",
      enabled: true,
      available: true,
      ...glm,
    },
  ];

  it("says so and offers a new thread on the default model", () => {
    expect(
      modelOffInfo(opts({}), { provider: "workers-ai", id: GLM })
    ).toBeNull();
    expect(
      modelOffInfo(opts({ enabled: false }), {
        provider: "workers-ai",
        id: GLM,
      })
    ).toEqual({
      message:
        "GLM-5.3 Flash is turned off in AI settings, so this conversation can't continue. Start a new thread with Claude Opus 5.5 to keep going.",
      next: {
        provider: "anthropic",
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
      },
    });
    expect(
      modelOffInfo(opts({}).slice(0, 1), { provider: "workers-ai", id: GLM })
        ?.message
    ).toMatch(/^@cf\/zai-org\/glm-5\.3-flash is no longer in AI settings/);
    // Claude turned off and GLM can't run here: no model to offer.
    const none = modelOffInfo(
      [
        { ...opts({})[0]!, enabled: false },
        { ...opts({})[1]!, available: false },
      ],
      { provider: "anthropic", id: "claude-opus-5-5" }
    );
    expect(none).toMatchObject({
      next: null,
      message: expect.stringContaining("Enable one in AI settings"),
    });
  });

  it("the thread view carries it with a summary to start the next thread", async () => {
    const store = await thread();
    const { ai } = fakeAi([{ text: "The hero is fine.", finish: "stop" }]);
    await turn(ai, store, "Check the hero");
    const t = (await store.getThread("t1"))!;
    const budget = await loadBudget(store, "t1", Date.now());
    expect(
      threadDetail(t, await store.messages("t1"), [], budget, opts({})).modelOff
    ).toBeNull();
    const off = threadDetail(
      t,
      await store.messages("t1"),
      [],
      budget,
      opts({ enabled: false })
    ).modelOff;
    expect(off).toMatchObject({
      next: { provider: "anthropic" },
      summary: expect.stringContaining("The hero is fine."),
    });
  });
});

describe("review lows", () => {
  it("keys streamed tool calls by id when the index is missing", async () => {
    const store = await thread();
    const frames = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { id: "a", function: { name: "list_pages", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "b",
                  function: { name: "get_page", arguments: '{"slug":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ id: "a", function: { arguments: "{}" } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: {
                    arguments: '"services/sample","mode":"outline"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    let calls = 0;
    const ai: AiBinding = {
      async run() {
        calls++;
        const body =
          calls === 1
            ? frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") +
              "data: [DONE]\n\n"
            : `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
        return new Response(body).body;
      },
    };
    await turn(ai, store, "x");
    const stored = await store.messages("t1");
    expect(
      (stored[2]!.content as { tool_calls: unknown[] }).tool_calls
    ).toEqual([
      {
        id: "a",
        type: "function",
        function: { name: "list_pages", arguments: "{}" },
      },
      {
        id: "b",
        type: "function",
        function: {
          name: "get_page",
          arguments: '{"slug":"services/sample","mode":"outline"}',
        },
      },
    ]);
    expect(
      stored
        .filter((m) => m.role === "tool")
        .map((m) => (m.content as { is_error?: boolean }).is_error ?? false)
    ).toEqual([false, false]);
  });

  it("caps the output budget at the model's context when known, else 32K", () => {
    expect(maxCompletionTokens(GLM)).toBe(MAX_COMPLETION_TOKENS);
    expect(maxCompletionTokens("@cf/acme/other")).toBe(32_000);
  });

  it("the context size leaves out reasoning tokens reported separately", () => {
    expect(
      contextTokensOf({
        prompt_tokens: 1000,
        completion_tokens: 300,
        completion_tokens_details: { reasoning_tokens: 250 },
      })
    ).toBe(1050);
    expect(
      contextTokensOf({ prompt_tokens: 1000, completion_tokens: 300 })
    ).toBe(1300);
    expect(contextTokensOf({ input_tokens: 5, output_tokens: 5 })).toBe(10);
  });
});

/** bun:test has no `vi.waitFor`: retries `check` until it stops throwing (or the timeout passes). */
async function waitFor(check: () => void, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
