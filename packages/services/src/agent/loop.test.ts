// biome-ignore-all lint/complexity/noCommaOperator: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noShadow: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { apiTools, parseToolInput } from "@repo/cms-core/agent/tool-defs";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import { sampleDoc, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import { validatePageDoc } from "@repo/cms-core/validate";
import {
  checkSlugAvailable,
  createPage,
  getPage,
  type ServiceDeps,
} from "../cms/pages-service";
import type { PageRow } from "../cms/repo";
import { createMemoryRepo } from "../testing/memory-repo";
import {
  type AgentClient,
  anthropicProvider,
  forward,
  requestBase,
  sanitizeAssistant,
} from "./anthropic";
import { loadBudget } from "./budget";
import { danglingToolUses, runTurn, unansweredTail } from "./loop";
import { createMemoryAgentStore } from "./memory-store";
import { canContinue } from "./thread-limits";
import { runTool, type ToolDeps } from "./tools";

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
    siteSeo: async () => {
      throw new Error("not used");
    },
    mediaSizes: async () => ({}),
    searchMedia: async () => [],
    getMedia: async () => null,
    pagePerformance: async () => {
      throw new Error("not used");
    },
    gscOverview: async () => {
      throw new Error("not used");
    },
    renderPreview: async () => new Uint8Array([0xff, 0xd8, 0xff]),
    shareImage: async () => {
      throw new Error("not used");
    },
    putScreenshot: async (threadId) => `r2:agent/screens/${threadId}/x.jpg`,
    previewLink: async ({ page, changesetId }) => ({
      url: `https://test.local/${page.slug}?_preview=t${changesetId ? `&cs=${changesetId}` : ""}`,
      expiresAt: "2026-10-03T01:00:00.000Z",
    }),
    createDraft: async () => {
      throw new Error("not used");
    },
    genId: (() => {
      let i = 0;
      return () => `cs${++i}`;
    })(),
  };
}

type Block = BetaMessage["content"][number];

function message(
  content: Block[],
  stop: BetaMessage["stop_reason"],
  usage: Partial<BetaMessage["usage"]> = {}
): BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  } as unknown as BetaMessage;
}

function eventsFor(msg: BetaMessage): BetaRawMessageStreamEvent[] {
  const out: BetaRawMessageStreamEvent[] = [];
  msg.content.forEach((block, index) => {
    if (block.type === "text") {
      out.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      } as BetaRawMessageStreamEvent);
      out.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      } as BetaRawMessageStreamEvent);
    } else if (block.type === "thinking") {
      out.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      } as BetaRawMessageStreamEvent);
      if (block.thinking) {
        out.push({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        } as BetaRawMessageStreamEvent);
      }
    } else {
      out.push({
        type: "content_block_start",
        index,
        content_block: block,
      } as BetaRawMessageStreamEvent);
    }
    out.push({
      type: "content_block_stop",
      index,
    } as BetaRawMessageStreamEvent);
  });
  return out;
}

/** Answers with the scripted messages in order and records every request. */
function fakeClient(script: BetaMessage[]) {
  const requests: MessageCreateParamsBase[] = [];
  const client: AgentClient = {
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const msg = script.shift();
          if (!msg) {
            throw new Error("no more scripted responses");
          }
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of eventsFor(msg)) {
                yield e;
              }
            },
            finalMessage: async () => msg,
          };
        },
      },
    },
  };
  return { client, requests };
}

const hydrate = async (c: unknown) => c as never;
const claude = (client: AgentClient) =>
  anthropicProvider(client, hydrate, TEST_CONFIG);

// ---------------------------------------------------------------------------------------------

describe("prompt-cache prefix", () => {
  it("tools and system are byte-identical across requests and free of per-request data", () => {
    const a = JSON.stringify({
      tools: requestBase(TEST_CONFIG).tools,
      system: requestBase(TEST_CONFIG).system,
    });
    const b = JSON.stringify({
      tools: requestBase(TEST_CONFIG).tools,
      system: requestBase(TEST_CONFIG).system,
    });
    expect(a).toBe(b);
    expect(a).not.toMatch(/20\d\d-\d\d-\d\dT/);
    const base = requestBase(TEST_CONFIG);
    // One breakpoint on the last system block, plus automatic caching of the conversation.
    const system = base.system as { cache_control?: unknown }[];
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(system.slice(0, -1).every((s) => !s.cache_control)).toBe(true);
    expect(base.cache_control).toEqual({ type: "ephemeral" });
    expect(base).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: "medium" },
    });
    expect(base.tool_choice).toBeUndefined();
  });

  it("every tool streams its input eagerly; closed read tools are strict", () => {
    const tools = apiTools();
    expect(tools.every((t) => t.eager_input_streaming)).toBe(true);
    expect(tools.find((t) => t.name === "get_page")?.strict).toBe(true);
    expect(tools.find((t) => t.name === "propose_ops")?.strict).toBeUndefined();
    expect(tools.map((t) => t.name)).not.toContain("publish");
  });

  it("later requests extend earlier ones: the transcript is append-only across turns", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "x",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const { client, requests } = fakeClient([
      message(
        [
          {
            type: "thinking",
            thinking: "Reading the page first.",
            signature: "sig1",
          } as Block,
          {
            type: "tool_use",
            id: "tu1",
            name: "get_page",
            input: { slug: "services/sample", mode: "outline" },
          } as Block,
        ],
        "tool_use"
      ),
      message([{ type: "text", text: "Here it is." } as Block], "end_turn"),
      message([{ type: "text", text: "Second answer." } as Block], "end_turn", {
        cache_read_input_tokens: 9000,
      }),
    ]);
    const events: AgentEvent[] = [];
    const deps = {
      provider: claude(client),
      store,
      tools: toolDeps(store),
      emit: (e: AgentEvent) => events.push(e),
    };
    await runTurn(deps, {
      threadId: "t1",
      pageId: "p1",
      user: "Hello",
      context: "Context 1",
    });
    await runTurn(deps, {
      threadId: "t1",
      pageId: "p1",
      user: "Again",
      context: "Context 2",
    });

    expect(requests).toHaveLength(3);
    for (let i = 1; i < requests.length; i++) {
      const prev = JSON.stringify(requests[i - 1]!.messages);
      expect(
        JSON.stringify(requests[i]!.messages).startsWith(prev.slice(0, -1))
      ).toBe(true);
      expect(JSON.stringify(requests[i]!.tools)).toBe(
        JSON.stringify(requests[0]!.tools)
      );
      expect(JSON.stringify(requests[i]!.system)).toBe(
        JSON.stringify(requests[0]!.system)
      );
    }
    // The context is a mid-conversation system message right after the user's message.
    expect(requests[0]!.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "system", content: "Context 1" },
    ]);
    // Thinking blocks are replayed verbatim (signature included).
    expect(JSON.stringify(requests[1]!.messages)).toContain(
      '"signature":"sig1"'
    );
    // The transcript holds every message once, in order.
    const stored = await store.messages("t1");
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "user",
      "assistant",
      "user",
      "system",
      "assistant",
    ]);
    expect(stored.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(3);
  });
});

describe("tool input validation inside the loop", () => {
  it("invalid input comes back as an is_error result the model can fix, and the turn continues", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "x",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const { client, requests } = fakeClient([
      message(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "get_page",
            input: { slug: "services/sample", mode: "everything" },
          } as Block,
        ],
        "tool_use"
      ),
      message(
        [
          {
            type: "tool_use",
            id: "tu2",
            name: "get_page",
            input: { slug: "services/sample", mode: "outline" },
          } as Block,
        ],
        "tool_use"
      ),
      message([{ type: "text", text: "Done." } as Block], "end_turn"),
    ]);
    const events: AgentEvent[] = [];
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
      },
      { threadId: "t1", pageId: "p1", user: "Hi", context: "c" }
    );
    const firstResult = (
      requests[1]!.messages.at(-1)!.content as {
        type: string;
        is_error?: boolean;
        content: string;
      }[]
    )[0]!;
    expect(firstResult.is_error).toBe(true);
    expect(JSON.parse(firstResult.content).errors[0]).toMatchObject({
      code: "INVALID_INPUT",
    });
    const second = (
      requests[2]!.messages.at(-1)!.content as { is_error?: boolean }[]
    )[0]!;
    expect(second.is_error).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === "tool_end")
        .map((e) => (e as { ok: boolean }).ok)
    ).toEqual([false, true]);
  });

  it("runs a response's tool calls in order, so a render after a proposal shows it", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "x",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const renders: (string | null)[] = [];
    const tools = {
      ...toolDeps(store),
      renderPreview: async (i: { changesetId: string | null }) => (
        renders.push(i.changesetId), new Uint8Array([1])
      ),
    };
    const { client } = fakeClient([
      message(
        [
          {
            type: "tool_use",
            id: "a",
            name: "propose_ops",
            input: {
              slug: "services/sample",
              summary: "s",
              ops: [
                {
                  op: "update",
                  key: "hero1",
                  style: { padding: { mobile: { top: 64 } } },
                },
              ],
            },
          } as Block,
          {
            type: "tool_use",
            id: "b",
            name: "render_preview",
            input: { slug: "services/sample", device: "mobile" },
          } as Block,
        ],
        "tool_use"
      ),
      message([{ type: "text", text: "ok" } as Block], "end_turn"),
    ]);
    await runTurn(
      { provider: claude(client), store, tools, emit: () => {} },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(renders).toEqual(["cs1"]);
    // Both results go back in one user message.
    const stored = await store.messages("t1");
    expect((stored[3]!.content as unknown[]).length).toBe(2);
  });

  it("propose_ops stages a changeset, supersedes the previous one and emits it", async () => {
    const store = createMemoryAgentStore();
    const deps = toolDeps(store);
    const ctx = {
      threadId: "t1",
      pageId: "p1",
      counts: { preview: 0, share: 0, create: 0 },
    };
    const first = await runTool(deps, ctx, "propose_ops", {
      slug: "services/sample",
      summary: "Hero for CFOs",
      ops: [
        { op: "update", key: "hero1", props: { heading: "Numbers first" } },
      ],
    });
    expect(first.isError).toBe(false);
    expect(first.changeset).toMatchObject({
      kind: "ops",
      status: "pending",
      summary: "Hero for CFOs",
    });
    const second = await runTool(deps, ctx, "propose_ops", {
      slug: "services/sample",
      summary: "Better",
      ops: [{ op: "update", key: "hero1", props: { heading: "Better" } }],
    });
    expect(second.isError).toBe(false);
    expect(store.rows.changesets.map((c) => c.status)).toEqual([
      "superseded",
      "pending",
    ]);
    // Nothing was written to the page itself.
    expect((await deps.pageById("p1"))!.draftDoc).toEqual(sampleDoc());
  });

  it("write tools act on the thread's page only, and render previews are capped", async () => {
    const deps = toolDeps();
    const ctx = {
      threadId: "t1",
      pageId: "other",
      counts: { preview: 0, share: 0, create: 0 },
    };
    const res = await runTool(deps, ctx, "propose_ops", {
      slug: "services/sample",
      summary: "x",
      ops: [{ op: "remove", key: "hero1" }],
    });
    expect(JSON.parse(res.content as string).errors[0].code).toBe("WRONG_PAGE");
    const own = {
      threadId: "t1",
      pageId: "p1",
      counts: { preview: 3, share: 0, create: 0 },
    };
    const capped = await runTool(deps, own, "render_preview", {
      slug: "services/sample",
      device: "mobile",
    });
    expect(JSON.parse(capped.content as string).errors[0].code).toBe(
      "LIMIT_REACHED"
    );
  });

  it("render_preview returns the image as a stored reference", async () => {
    const deps = toolDeps();
    const res = await runTool(
      deps,
      {
        threadId: "t1",
        pageId: "p1",
        counts: { preview: 0, share: 0, create: 0 },
      },
      "render_preview",
      { slug: "services/sample", device: "mobile", focus_key: "hero1" }
    );
    expect(res.isError).toBe(false);
    expect(res.content).toEqual([
      expect.objectContaining({ type: "text" }),
      {
        type: "image",
        source: {
          type: "ref",
          ref: "r2:agent/screens/t1/x.jpg",
          media_type: "image/jpeg",
        },
      },
    ]);
  });

  it("parseToolInput rejects extra keys and wrong enums", () => {
    expect(parseToolInput("get_page", { slug: "", mode: "outline" }).ok).toBe(
      true
    );
    expect(
      parseToolInput("get_page", { slug: "", mode: "outline", extra: 1 }).ok
    ).toBe(false);
    expect(
      parseToolInput("render_preview", { slug: "", device: "watch" }).ok
    ).toBe(false);
    expect(
      parseToolInput("propose_seo", {
        slug: "",
        seo: { slug: "new-slug" },
        variants: [],
      }).ok
    ).toBe(false);
  });
});

describe("stop reasons and repairs", () => {
  it("a refusal stops the loop and answers its tool calls with errors", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "x",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const refused = message(
      [{ type: "tool_use", id: "tu1", name: "list_pages", input: {} } as Block],
      "refusal"
    );
    (refused as unknown as { stop_details: unknown }).stop_details = {
      type: "refusal",
      category: "cyber",
      explanation: "no",
    };
    const { client, requests } = fakeClient([refused]);
    const events: AgentEvent[] = [];
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
      },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(requests).toHaveLength(1);
    expect(events).toContainEqual({
      type: "refusal",
      category: "cyber",
      explanation: "no",
    });
    expect(danglingToolUses(await store.messages("t1"))).toEqual([]);
  });

  it("an interrupted request's tool calls are answered before the next message", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "x",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await store.append("t1", [
      { seq: 0, role: "user", content: "x", createdAt: new Date(0) },
      {
        seq: 1,
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu9", name: "list_pages", input: {} },
        ],
        createdAt: new Date(0),
      },
    ]);
    const { client, requests } = fakeClient([
      message([{ type: "text", text: "ok" } as Block], "end_turn"),
    ]);
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      { threadId: "t1", pageId: "p1", user: "y", context: "c" }
    );
    const roles = requests[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "user", "system"]);
    expect(JSON.stringify(requests[0]!.messages[2]!)).toContain(
      '"tool_use_id":"tu9"'
    );
  });

  it("drops blocks before a mid-output fallback that the fallback model can't continue", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Partial" },
      {
        type: "fallback",
        from: { model: "claude-opus-5-5" },
        to: { model: "claude-opus-4-8" },
      },
      { type: "text", text: "Rest" },
    ] as unknown as Block[];
    expect(sanitizeAssistant(content).map((b) => b.type)).toEqual([
      "text",
      "fallback",
      "text",
    ]);
  });
});

describe("SSE event shaping", () => {
  it("maps stream events to chat events: text deltas, progress notes on block stop, tool starts, fallbacks", () => {
    const events: AgentEvent[] = [];
    const progress = new Map<number, string>();
    const emit = { emit: (e: AgentEvent) => events.push(e) };
    const stream: BetaRawMessageStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Checking the hero" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " on mobile." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "tu1",
          name: "render_preview",
          input: {},
        },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "fallback",
          from: { model: "a" },
          to: { model: "b" },
        },
      },
      {
        type: "content_block_start",
        index: 4,
        content_block: { type: "text", text: "", citations: null },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "text_delta", text: "Done" },
      },
    ] as unknown as BetaRawMessageStreamEvent[];
    for (const e of stream) {
      forward(emit, e, progress);
    }
    expect(events).toEqual([
      { type: "progress", text: "Checking the hero on mobile." },
      {
        type: "tool_start",
        tool: {
          id: "tu1",
          name: "render_preview",
          label: "Rendering a  preview",
        },
      },
      { type: "fallback", from: "a", to: "b" },
      { type: "text", text: "Done" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes: valid transcripts after failures, stop reasons, budgets, detaching, create_page

type Step =
  | BetaMessage
  | { fail: Error; partial?: BetaMessage; onFail?: () => void };

/** Like fakeClient, but a step can fail mid-stream (after streaming `partial`), optionally aborting first. */
function stepClient(steps: Step[]) {
  const requests: MessageCreateParamsBase[] = [];
  const client: AgentClient = {
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const step = steps.shift();
          if (!step) {
            throw new Error("no more scripted responses");
          }
          if ("fail" in step) {
            return {
              currentMessage: step.partial,
              async *[Symbol.asyncIterator]() {
                if (step.partial) {
                  for (const e of eventsFor(step.partial)) {
                    yield e;
                  }
                }
                step.onFail?.();
                throw step.fail;
              },
              finalMessage: async () => {
                throw step.fail;
              },
            };
          }
          return {
            currentMessage: step,
            async *[Symbol.asyncIterator]() {
              for (const e of eventsFor(step)) {
                yield e;
              }
            },
            finalMessage: async () => step,
          };
        },
      },
    },
  };
  return { client, requests };
}

/** The API's role rules for mid-conversation system messages: never first, after a user message, then last or followed by an assistant message. */
function expectValidRoles(messages: MessageCreateParamsBase["messages"]) {
  const roles = messages.map((m) => m.role as string);
  expect(roles[0]).toBe("user");
  roles.forEach((r, i) => {
    if (r !== "system") {
      return;
    }
    expect(roles[i - 1]).toBe("user");
    if (i < roles.length - 1) {
      expect(roles[i + 1]).toBe("assistant");
    }
  });
}

async function newThread(store = createMemoryAgentStore()) {
  await store.createThread({
    id: "t1",
    pageId: "p1",
    title: "x",
    author: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  return store;
}

describe("H1: a failed or stopped first call leaves the thread usable", () => {
  it("an API error during the first call stores nothing; the next turn's request is valid", async () => {
    const store = await newThread();
    const { client, requests } = stepClient([
      {
        fail: new Anthropic.BadRequestError(
          400,
          {
            type: "error",
            error: { type: "invalid_request_error", message: "boom" },
          },
          "boom",
          new Headers()
        ),
      },
      message([{ type: "text", text: "Hi again." } as Block], "end_turn"),
    ]);
    const deps = {
      provider: claude(client),
      store,
      tools: toolDeps(store),
      emit: () => {},
    };
    await expect(
      runTurn(deps, {
        threadId: "t1",
        pageId: "p1",
        user: "First",
        context: "c1",
      })
    ).rejects.toThrow();
    expect(await store.messages("t1")).toEqual([]);
    await runTurn(deps, {
      threadId: "t1",
      pageId: "p1",
      user: "Second",
      context: "c2",
    });
    expectValidRoles(requests[1]!.messages);
    expect(requests[1]!.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
    ]);
    expect((await store.messages("t1")).map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
    ]);
  });

  it("Stop during the first call drops its output, records the spend so far, and the next turn is valid", async () => {
    const store = await newThread();
    const ac = new AbortController();
    const partial = message(
      [{ type: "text", text: "Half a sen" } as Block],
      null,
      { input_tokens: 15_000, output_tokens: 0 }
    );
    const { client, requests } = stepClient([
      {
        fail: new Anthropic.APIUserAbortError(),
        partial,
        onFail: () => ac.abort(),
      },
      message([{ type: "text", text: "Fine." } as Block], "end_turn"),
    ]);
    const events: AgentEvent[] = [];
    const first = await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
        signal: ac.signal,
      },
      { threadId: "t1", pageId: "p1", user: "First", context: "c1" }
    );
    expect(first.stopReason).toBe("aborted");
    expect(await store.messages("t1")).toEqual([]);
    expect(store.rows.usage).toEqual([
      expect.objectContaining({
        threadId: "t1",
        kind: "aborted",
        costUsd: 0.06,
      }),
    ]);
    expect(await store.threadCost("t1")).toBeCloseTo(0.06, 6);

    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      { threadId: "t1", pageId: "p1", user: "Second", context: "c2" }
    );
    expectValidRoles(requests[1]!.messages);
    expect(JSON.stringify(requests[1]!.messages)).not.toContain("First");
  });

  it("repairs a transcript poisoned before the fix: unanswered user and system rows are removed, tool results kept", async () => {
    const store = await newThread();
    await store.append("t1", [
      { seq: 0, role: "user", content: "a", createdAt: new Date(0) },
      { seq: 1, role: "system", content: "c", createdAt: new Date(0) },
      {
        seq: 2,
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "list_pages", input: {} },
        ],
        createdAt: new Date(0),
      },
      {
        seq: 3,
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "[]" }],
        createdAt: new Date(0),
      },
      { seq: 4, role: "user", content: "b", createdAt: new Date(0) },
      { seq: 5, role: "system", content: "c", createdAt: new Date(0) },
    ]);
    expect(unansweredTail(await store.messages("t1"))).toEqual([4, 5]);
    const { client, requests } = stepClient([
      message([{ type: "text", text: "ok" } as Block], "end_turn"),
    ]);
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      { threadId: "t1", pageId: "p1", user: "c", context: "c3" }
    );
    expectValidRoles(requests[0]!.messages);
    expect(requests[0]!.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "user",
      "user",
      "system",
    ]);
    expect((await store.messages("t1")).map((m) => m.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("decisions are marked reported only when the turn's rows are stored", async () => {
    const store = await newThread();
    const at = new Date(5000);
    const ac = new AbortController();
    const { client } = stepClient([
      { fail: new Anthropic.APIUserAbortError(), onFail: () => ac.abort() },
      message([{ type: "text", text: "ok" } as Block], "end_turn"),
    ]);
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: () => {},
        signal: ac.signal,
      },
      {
        threadId: "t1",
        pageId: "p1",
        user: "x",
        context: "c",
        decisionsReportedAt: at,
      }
    );
    expect(
      (await store.getThread("t1"))!.decisionsReportedAt ?? null
    ).toBeNull();
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: () => {},
      },
      {
        threadId: "t1",
        pageId: "p1",
        user: "x",
        context: "c",
        decisionsReportedAt: at,
      }
    );
    expect((await store.getThread("t1"))!.decisionsReportedAt).toEqual(at);
  });
});

describe("stop reasons, retries and detaching", () => {
  it("M6: tool calls in a response that didn't stop for tool use are answered with errors, not run", async () => {
    const store = await newThread();
    let ran = 0;
    const tools = { ...toolDeps(store), listPages: async () => (ran++, []) };
    const { client, requests } = stepClient([
      message(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "list_pages",
            input: {},
          } as Block,
        ],
        "end_turn"
      ),
    ]);
    await runTurn(
      { provider: claude(client), store, tools, emit: () => {} },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(ran).toBe(0);
    expect(requests).toHaveLength(1);
    const last = (await store.messages("t1")).at(-1)!;
    expect(last.content).toEqual([
      expect.objectContaining({ tool_use_id: "tu1", is_error: true }),
    ]);
  });

  it("max_tokens ends the turn with a notice", async () => {
    const store = await newThread();
    const { client } = stepClient([
      message([{ type: "text", text: "Long" } as Block], "max_tokens"),
    ]);
    const events: AgentEvent[] = [];
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
      },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(events).toContainEqual({
      type: "notice",
      text: expect.stringContaining("output limit"),
    });
  });

  it("a malformed tool input is retried: the chat is told to drop the failed attempt, and its spend is recorded", async () => {
    const store = await newThread();
    const partial = message(
      [{ type: "text", text: "Proposing" } as Block],
      null,
      { input_tokens: 1000, output_tokens: 0 }
    );
    const { client, requests } = stepClient([
      {
        fail: new Anthropic.AnthropicError(
          "Unable to parse tool parameter JSON from model."
        ),
        partial,
      },
      message([{ type: "text", text: "Done." } as Block], "end_turn"),
    ]);
    const events: AgentEvent[] = [];
    await runTurn(
      {
        provider: claude(client),
        store,
        tools: toolDeps(store),
        emit: (e) => events.push(e),
      },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(requests).toHaveLength(2);
    const types = events.map((e) => e.type);
    expect(types.indexOf("reset")).toBeGreaterThan(types.indexOf("text"));
    expect(store.rows.usage).toEqual([
      expect.objectContaining({ kind: "retry", costUsd: 0.004 }),
    ]);
  });

  it("after the tab goes away, the current call is stored but its tools don't run and no further call is made", async () => {
    const store = await newThread();
    let ran = 0;
    const tools = { ...toolDeps(store), listPages: async () => (ran++, []) };
    const { client, requests } = stepClient([
      message(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "list_pages",
            input: {},
          } as Block,
        ],
        "tool_use"
      ),
    ]);
    const res = await runTurn(
      {
        provider: claude(client),
        store,
        tools,
        emit: () => {},
        detached: () => true,
      },
      { threadId: "t1", pageId: "p1", user: "x", context: "c" }
    );
    expect(res.stopReason).toBe("detached");
    expect(ran).toBe(0);
    expect(requests).toHaveLength(1);
    expect((await store.messages("t1")).map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "user",
    ]);
    expect(danglingToolUses(await store.messages("t1"))).toEqual([]);
  });
});

describe("M1: spending caps pause the turn; an override continues it", () => {
  const toolCall = (id: string) =>
    message(
      [{ type: "tool_use", id, name: "list_pages", input: {} } as Block],
      "tool_use"
    );

  it("pauses before the next call at the thread cap, then continues after 'No limit for this thread'", async () => {
    const store = await newThread();
    // One call costs (10×4 + 20×20)/1e6 = $0.00044.
    store.rows.settings = { threadCapUsd: 0.0004, dailyCapUsd: null };
    const { client, requests } = stepClient([
      toolCall("tu1"),
      message([{ type: "text", text: "Done." } as Block], "end_turn"),
    ]);
    const events: AgentEvent[] = [];
    const budget = () =>
      loadBudget(store, "t1", Date.parse("2026-10-02T03:00:00Z"));
    const deps = {
      provider: claude(client),
      store,
      tools: toolDeps(store),
      emit: (e: AgentEvent) => events.push(e),
      budget,
    };
    const first = await runTurn(deps, {
      threadId: "t1",
      pageId: "p1",
      user: "x",
      context: "c",
    });
    expect(first.stopReason).toBe("budget");
    expect(requests).toHaveLength(1);
    expect(events.filter((e) => e.type === "budget").at(-1)).toMatchObject({
      budget: { blocked: "thread", thread: { capUsd: 0.0004 } },
    });
    const stored = await store.messages("t1");
    expect(canContinue(stored)).toBe(true);

    await store.addOverride({
      id: "o1",
      scope: "thread",
      threadId: "t1",
      day: null,
      amountUsd: null,
      createdBy: "admin@example.com",
      createdAt: new Date(0).toISOString(),
    });
    const second = await runTurn(deps, { threadId: "t1", pageId: "p1" });
    expect(second.stopReason).toBe("end_turn");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.role).toBe("user");
    expectValidRoles(requests[1]!.messages);
    expect((await budget()).thread).toMatchObject({
      capUsd: null,
      overrides: [
        expect.objectContaining({ createdBy: "admin@example.com" }),
      ],
    });
  });

  it("the daily cap counts every thread's spend today, and '+$20 today' raises only today's", async () => {
    const store = await newThread();
    store.rows.settings = { threadCapUsd: null, dailyCapUsd: 20 };
    const now = Date.parse("2026-10-02T03:00:00Z"); // 13:00 in Sydney
    store.rows.usage.push({
      id: "u1",
      threadId: "other",
      kind: "error",
      model: null,
      usage: null,
      costUsd: 20.5,
      createdAt: new Date(now - 60_000),
    });
    store.rows.usage.push({
      id: "u0",
      threadId: "other",
      kind: "error",
      model: null,
      usage: null,
      costUsd: 99,
      createdAt: new Date(now - 86_400_000),
    });
    expect(await loadBudget(store, "t1", now)).toMatchObject({
      blocked: "day",
      day: { spentUsd: 20.5, capUsd: 20, day: "2026-10-02" },
    });
    await store.addOverride({
      id: "o1",
      scope: "day",
      threadId: null,
      day: "2026-10-02",
      amountUsd: 20,
      createdBy: "d",
      createdAt: new Date(now).toISOString(),
    });
    expect(await loadBudget(store, "t1", now)).toMatchObject({
      blocked: null,
      day: { capUsd: 40, remainingUsd: 19.5 },
    });
    // Tomorrow the override no longer applies (and yesterday's spend never counted).
    expect((await loadBudget(store, "t1", now + 86_400_000)).day).toMatchObject(
      { capUsd: 20, spentUsd: 0 }
    );
  });
});

describe("create_page", () => {
  function draftDeps() {
    const mem = createMemoryRepo();
    const d: ServiceDeps = {
      repo: mem.repo,
      kv: {
        put: async () => {},
        delete: async () => {},
        get: async () => null,
      },
      validate: validatePageDoc,
      labelFor: (t) => t,
    };
    const deps: ToolDeps = {
      ...toolDeps(),
      createDraft: async (input) => {
        await checkSlugAvailable(d, input.kind, input.slug);
        return createPage(d, input);
      },
    };
    return { deps, d };
  }
  const ctx = () => ({
    threadId: "t1",
    pageId: "p1",
    counts: { preview: 0, share: 0, create: 0 },
  });

  it("creates an unpublished post draft with the agent's blocks (Markdown rich text) and returns its editor link", async () => {
    const { deps, d } = draftDeps();
    const res = await runTool(deps, ctx(), "create_page", {
      kind: "post",
      slug: "blog/notes-to-post",
      title: "Notes to post",
      blocks: [
        { _type: "richText", props: { body: "## Why\n\nShort **notes**." } },
      ],
      post: {
        category: "AI strategy",
        author: "Alex Admin",
        excerpt: "From notes.",
      },
    });
    expect(res.isError).toBe(false);
    expect(res.created).toMatchObject({
      kind: "post",
      slug: "blog/notes-to-post",
      editorUrl: expect.stringMatching(/^\/admin\/editor\//),
    });
    const page = await getPage(d, { id: res.created!.id });
    expect(page).toMatchObject({
      status: "draft",
      kind: "post",
      liveRevId: null,
    });
    expect(page!.draftDoc!.post).toMatchObject({
      category: "AI strategy",
      excerpt: "From notes.",
    });
    expect(JSON.stringify(page!.draftDoc!.blocks[0]!.props)).toContain(
      '"type":"heading"'
    );
  });

  it("refuses reserved and taken slugs, and a post without a category to take", async () => {
    const { deps } = draftDeps();
    const reserved = await runTool(deps, ctx(), "create_page", {
      kind: "page",
      slug: "admin/ai-strategy",
      title: "X",
    });
    expect(JSON.parse(reserved.content as string).errors[0].code).toBe(
      "SLUG_RESERVED"
    );
    const noCategory = await runTool(deps, ctx(), "create_page", {
      kind: "post",
      slug: "blog/x",
      title: "X",
    });
    expect(JSON.parse(noCategory.content as string).errors[0]).toMatchObject({
      code: "INVALID_INPUT",
      path: "post.category",
    });
    const okPage = await runTool(deps, ctx(), "create_page", {
      kind: "page",
      slug: "new-thing",
      title: "New",
    });
    expect(okPage.isError).toBe(false);
    const taken = await runTool(deps, ctx(), "create_page", {
      kind: "page",
      slug: "new-thing",
      title: "New",
    });
    expect(JSON.parse(taken.content as string).errors[0].code).toBe(
      "SLUG_TAKEN"
    );
  });

  it("is offered to the model and labelled in the chat", () => {
    expect(apiTools().map((t) => t.name)).toContain("create_page");
    expect(apiTools().map((t) => t.name)).not.toContain("publish");
  });
});

describe("get_preview_url", () => {
  const ctx = () => ({
    threadId: "t1",
    pageId: "p1",
    counts: { preview: 0, share: 0, create: 0 },
  });
  const cs = (
    id: string,
    status: "pending" | "accepted",
    pageId = "p1",
    at = 0
  ) => ({
    id,
    threadId: "t1",
    pageId,
    kind: "ops" as const,
    summary: id,
    status,
    payload: { ops: [] },
    baseDoc: sampleDoc(),
    proposedDoc: sampleDoc(),
    warnings: [],
    decision: null,
    createdAt: new Date(at),
    decidedAt: null,
  });

  it("links to the draft, the newest pending proposal, or a named pending one of this page", async () => {
    const store = createMemoryAgentStore();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "t",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    for (const c of [
      cs("old", "pending", "p1", 1),
      cs("new", "pending", "p1", 2),
      cs("done", "accepted"),
      cs("elsewhere", "pending", "p2", 3),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: ported verbatim from the source test; order doesn't matter.
      await store.insertChangeset(c);
    }
    const deps = toolDeps(store);
    const read = async (input: Record<string, unknown>) => {
      const res = await runTool(deps, ctx(), "get_preview_url", {
        slug: "services/sample",
        ...input,
      });
      return { isError: res.isError, body: JSON.parse(res.content as string) };
    };
    expect(await read({})).toMatchObject({
      isError: false,
      body: {
        renders: "draft",
        url: "https://test.local/services/sample?_preview=t",
      },
    });
    expect(await read({ changeset: "latest", device: "mobile" })).toMatchObject(
      { body: { renders: "changeset new", viewportWidth: 390 } }
    );
    expect(await read({ changeset: "old" })).toMatchObject({
      body: { renders: "changeset old" },
    });
    expect(await read({ changeset: "done" })).toMatchObject({
      isError: true,
      body: { errors: [{ code: "NOT_ALLOWED" }] },
    });
    expect(await read({ changeset: "elsewhere" })).toMatchObject({
      isError: true,
      body: { errors: [{ code: "NOT_FOUND" }] },
    });
  });

  it("says so when there is no pending proposal for latest", async () => {
    const res = await runTool(toolDeps(), ctx(), "get_preview_url", {
      slug: "services/sample",
      changeset: "latest",
    });
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("No pending proposal");
  });
});
