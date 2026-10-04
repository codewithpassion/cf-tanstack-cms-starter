// biome-ignore-all lint/style/noNonNullAssertion: test code indexes rows it just created.
// biome-ignore-all lint/suspicious/useAwait: async stubs satisfy promise-returning ports.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose.
import { describe, expect, it } from "bun:test";
import { LOCK_RENEW_MS, MAX_THREAD_TURNS } from "@repo/cms-core/agent/limits";
import { approveRun, newRunItems, type Run } from "@repo/cms-core/agent/run";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import { MEDIA_ID, sampleDoc, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import { validatePageDoc } from "@repo/cms-core/validate";
import type { PageRow } from "../cms/repo";
import { createMemoryKv } from "../testing/memory-kv";
import { createMemoryRepo } from "../testing/memory-repo";
import { createMemoryAgentStore } from "./memory-store";
import type { ModelProvider, StepResult } from "./provider";
import type { StoredMessage } from "./store-port";
import type { ToolDeps } from "./tools";
import { beginTurn, stopTurn, type TurnDeps, type TurnLog } from "./turn";

const T0 = Date.parse("2026-10-02T03:00:00Z");

function page(over: Partial<PageRow> = {}): PageRow {
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
    ...over,
  };
}

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
};

const answer = (text: string): StepResult => ({
  assistant: {
    content: [{ type: "text", text }],
    model: "fake",
    stopReason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    costUsd: 0.01,
  },
  calls: [],
  stop: "end",
  stopReason: "end_turn",
  usage,
});

function provider(
  step: ModelProvider["step"] = async () => answer("Done.")
): ModelProvider {
  return {
    id: "anthropic",
    model: "fake",
    step,
    toolResultRows: (results) =>
      results.map((r) => ({
        role: "user" as const,
        content: [
          { type: "tool_result", tool_use_id: r.id, content: r.content },
        ],
      })),
  };
}

function setup(
  opts: {
    page?: PageRow;
    provider?: ModelProvider;
    stopPollMs?: number;
    now?: () => number;
  } = {}
) {
  const store = createMemoryAgentStore();
  const p = opts.page ?? page();
  const unused = async () => {
    throw new Error("not used");
  };
  const tools: ToolDeps = {
    config: TEST_CONFIG,
    store,
    pageBySlug: async (slug) => (slug === p.slug ? p : null),
    pageById: async (id) => (id === p.id ? p : null),
    liveDoc: async () => null,
    listPages: async () => [p],
    draftPages: async () => [],
    siteSeo: unused,
    mediaSizes: async () => ({}),
    searchMedia: async () => [],
    getMedia: async () => null,
    pagePerformance: unused,
    gscOverview: unused,
    renderPreview: unused,
    shareImage: unused,
    putScreenshot: unused,
    previewLink: unused,
    createDraft: unused,
  };
  const logs: string[] = [];
  const log: TurnLog = {
    error: (m) => logs.push(m),
    info: (m) => logs.push(m),
  };
  let n = 0;
  const deps: TurnDeps = {
    store,
    tools,
    cms: {
      repo: createMemoryRepo().repo,
      kv: createMemoryKv().kv,
      validate: validatePageDoc,
      labelFor: (t) => t,
    },
    availability: { anthropic: true, workersAi: false },
    provider: () => opts.provider ?? provider(),
    getMedia: async (id) =>
      id === MEDIA_ID
        ? { id, mime: "image/png", width: 10, height: 20, alt: null }
        : null,
    now: opts.now ?? (() => T0),
    genId: () => {
      n += 1;
      return `id${n}`;
    },
    log,
    stopPollMs: opts.stopPollMs ?? 5,
  };
  return { store, deps, logs };
}

const context = { device: "desktop", selectedKey: null, draftVersion: 3 };
type Req = { body: Record<string, unknown>; userId: string };
const send = (message: string, extra: Record<string, unknown> = {}): Req => ({
  body: { pageId: "p1", message, context, ...extra },
  userId: "u1",
});

async function run(deps: TurnDeps, req: Req) {
  const begun = await beginTurn(deps, req);
  if (!begun.ok) {
    throw new Error(`refused: ${begun.body.message}`);
  }
  const events: AgentEvent[] = [];
  await begun.execute({ emit: (e) => events.push(e), detached: () => false });
  return { begun, events };
}

const refusal = async (
  deps: TurnDeps,
  req: Parameters<typeof beginTurn>[1]
) => {
  const res = await beginTurn(deps, req);
  if (res.ok) {
    throw new Error("expected a refusal");
  }
  return res;
};

describe("beginTurn: refusals (nothing is created or locked)", () => {
  it("rejects a body that fails validation", async () => {
    const { deps, store } = setup();
    const res = await refusal(deps, { body: { pageId: "p1" }, userId: "u" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(store.rows.threads).toHaveLength(0);
  });

  it("rejects sending a message and continuing together", async () => {
    const { deps } = setup();
    const res = await refusal(
      deps,
      send("hi", { continue: true, threadId: "t" })
    );
    expect(res.status).toBe(400);
  });

  it("404 for an unknown page, 400 for an archived one", async () => {
    const { deps } = setup();
    expect(
      (
        await refusal(deps, {
          ...send("hi"),
          body: { ...send("hi").body, pageId: "nope" },
        })
      ).status
    ).toBe(404);
    const archived = setup({ page: page({ status: "archived" }) });
    expect((await refusal(archived.deps, send("hi"))).status).toBe(400);
  });

  it("404 for a conversation of another page", async () => {
    const { deps, store } = setup();
    await store.createThread({
      id: "t1",
      pageId: "other",
      title: "x",
      author: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
    });
    const res = await refusal(deps, send("hi", { threadId: "t1" }));
    expect(res.status).toBe(404);
  });

  it("503 when the model can't run here, 400 when it isn't enabled", async () => {
    const { deps } = setup();
    const off = {
      ...deps,
      availability: { anthropic: false, workersAi: false },
    };
    const res = await refusal(off, send("hi"));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MODEL_UNAVAILABLE");
    const unknown = await refusal(
      deps,
      send("hi", { model: { provider: "anthropic", id: "not-a-model" } })
    );
    expect(unknown.status).toBe(400);
  });

  it("402 once the day's cap is reached, with the budget in the body", async () => {
    const { deps, store } = setup();
    await store.saveSettings(
      { threadCapUsd: 3, dailyCapUsd: 0.5 },
      null,
      new Date(T0)
    );
    await store.recordUsage({
      id: "u1",
      threadId: "t",
      kind: "alt-text",
      model: null,
      usage: null,
      costUsd: 1,
      createdAt: new Date(T0),
    });
    const res = await refusal(deps, send("hi"));
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("BUDGET");
    expect(res.body.budget).toBeDefined();
    expect(store.rows.threads).toHaveLength(0);
  });

  it("409 THREAD_FULL past the turn limit, with a summary to carry over", async () => {
    const { deps, store } = setup();
    await store.createThread({
      id: "t1",
      pageId: "p1",
      title: "Long one",
      author: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
    });
    const rows: StoredMessage[] = [];
    for (let i = 0; i < MAX_THREAD_TURNS; i += 1) {
      rows.push(
        {
          seq: 2 * i,
          role: "user",
          content: [{ type: "text", text: `q${i}` }],
          createdAt: new Date(T0),
        },
        {
          seq: 2 * i + 1,
          role: "assistant",
          content: [{ type: "text", text: `a${i}` }],
          usage: { input_tokens: 1, output_tokens: 1 },
          createdAt: new Date(T0),
        }
      );
    }
    await store.append("t1", rows);
    const res = await refusal(deps, send("more", { threadId: "t1" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("THREAD_FULL");
    expect(res.body.full).toMatchObject({ reason: "turns" });
  });

  it("409 MODEL_OFF when the thread's model was turned off in AI settings", async () => {
    const { deps, store } = setup();
    await run(deps, send("hello"));
    const thread = store.rows.threads[0]!;
    await store.saveModels(
      [
        {
          provider: "anthropic",
          id: thread.model ?? "x",
          label: "Claude",
          enabled: false,
        },
        {
          provider: "workers-ai",
          id: "@cf/some-model",
          label: "Other",
          enabled: true,
        },
      ],
      null,
      new Date(T0)
    );
    const res = await refusal(deps, send("more", { threadId: thread.id }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MODEL_OFF");
    expect(res.body.modelOff).toBeDefined();
    expect(store.rows.threads[0]?.lockId ?? null).toBeNull();
  });

  it("409 NOTHING_TO_CONTINUE when no turn is paused", async () => {
    const { deps, store } = setup();
    await run(deps, send("hello"));
    const threadId = store.rows.threads[0]!.id;
    const res = await refusal(deps, {
      body: { pageId: "p1", threadId, continue: true, context },
      userId: "u1",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOTHING_TO_CONTINUE");
  });

  it("409 BUSY while another tab holds the turn lock, and the lock is untouched", async () => {
    const { deps, store } = setup();
    await run(deps, send("hello"));
    const threadId = store.rows.threads[0]!.id;
    expect(
      (await store.acquireLock(threadId, "other-tab", new Date(T0))).ok
    ).toBe(true);
    const res = await refusal(deps, send("again", { threadId }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BUSY");
    expect(res.body.takeoverAfterMs).toBeGreaterThan(0);
    expect(store.rows.threads[0]?.lockId).toBe("other-tab");
  });

  it("400 for an image that isn't in the library or isn't supported, releasing the lock and the new thread", async () => {
    const { deps, store } = setup();
    const res = await refusal(
      deps,
      send("look", { images: [`${"b".repeat(64)}.png`] })
    );
    expect(res.status).toBe(400);
    expect(store.rows.threads).toHaveLength(0);
  });
});

describe("beginTurn: a turn", () => {
  it("creates the thread under the lock, streams its events, stores the turn and releases the lock", async () => {
    const { deps, store } = setup();
    const begun = await beginTurn(deps, send("  Make the hero shorter  "));
    expect(begun.ok).toBe(true);
    if (!begun.ok) {
      return;
    }
    // The lock is held between beginTurn and execute.
    const held = store.rows.threads.find((t) => t.id === begun.threadId);
    expect(held?.lockId).toBeTruthy();
    const events: AgentEvent[] = [];
    await begun.execute({ emit: (e) => events.push(e), detached: () => false });
    expect(events.map((e) => e.type)).toEqual([
      "thread",
      "budget",
      "call_start",
      "usage",
      "budget",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      type: "thread",
      threadId: begun.threadId,
      title: "Make the hero shorter",
      provider: "anthropic",
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "end_turn",
    });
    const thread = store.rows.threads.find((t) => t.id === begun.threadId);
    expect(thread?.lockId ?? null).toBeNull();
    expect(thread?.author).toBe("u1");
    expect(thread?.scope).toBe("page");
    // The turn's rows are stored with the first answer: context, the user message, the reply.
    const stored = store.rows.messages.get(begun.threadId) ?? [];
    expect(stored.map((m) => m.role)).toContain("assistant");
    expect(JSON.stringify(stored)).toContain("Make the hero shorter");
    expect(JSON.stringify(stored)).toContain("services/sample");
  });

  it("a model error is reported as an error event, then done; the lock is released and an empty new thread removed", async () => {
    const failing = provider(async () => {
      throw new Error("model exploded");
    });
    const { deps, store, logs } = setup({ provider: failing });
    const { begun, events } = await run(deps, send("hello"));
    expect(events).toContainEqual({ type: "error", message: "model exploded" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "error" });
    expect(events.some((e) => e.type === "thread_gone")).toBe(true);
    expect(
      store.rows.threads.find((t) => t.id === begun.threadId)
    ).toBeUndefined();
    expect(logs).toContain("agent turn failed");
  });

  it("Stop aborts the model call in flight and the lock is released", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const waiting = provider((input) => {
      started();
      return new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(null));
      });
    });
    const { deps, store } = setup({ provider: waiting });
    const begun = await beginTurn(deps, send("hello"));
    if (!begun.ok) {
      throw new Error("refused");
    }
    const events: AgentEvent[] = [];
    const done = begun.execute({
      emit: (e) => events.push(e),
      detached: () => false,
    });
    await running;
    expect(await stopTurn(store, begun.threadId)).toEqual({
      ok: true,
      stopping: true,
    });
    await done;
    expect(events.at(-1)?.type).toBe("done");
    expect(
      store.rows.threads.find((t) => t.id === begun.threadId)?.lockId ?? null
    ).toBeNull();
  });

  it("stopping a thread with no running turn reports stopping: false", async () => {
    const { store } = setup();
    expect(await stopTurn(store, "nope")).toEqual({
      ok: true,
      stopping: false,
    });
  });

  it("renews the lock while the turn runs (every LOCK_RENEW_MS)", async () => {
    let clock = T0;
    let calls = 0;
    const slow = provider(async (input) => {
      // Let the poll run a few times while time moves on.
      for (let i = 0; i < 6; i += 1) {
        clock += LOCK_RENEW_MS;
        await new Promise((r) => setTimeout(r, 12));
      }
      return input.signal?.aborted ? null : answer("ok");
    });
    const { deps, store } = setup({ provider: slow, now: () => clock });
    const original = store.renewLock.bind(store);
    store.renewLock = (...args) => {
      calls += 1;
      return original(...args);
    };
    await run(deps, send("hello"));
    expect(calls).toBeGreaterThan(0);
  });

  it("puts decisions made since the last report into the user's message as data, and records the report time", async () => {
    const { deps, store } = setup();
    const { begun } = await run(deps, send("first"));
    await store.insertChangeset({
      id: "cs1",
      threadId: begun.threadId,
      pageId: "p1",
      kind: "ops",
      summary: "Shorten the hero",
      status: "accepted",
      payload: { ops: [] },
      baseDoc: sampleDoc(),
      proposedDoc: sampleDoc(),
      warnings: null,
      decision: { accepted: [], rejected: [], revId: null },
      createdAt: new Date(T0),
      decidedAt: new Date(T0 + 1000),
    });
    await run(deps, send("second", { threadId: begun.threadId }));
    const stored = store.rows.messages.get(begun.threadId) ?? [];
    const userRows = stored.filter((m) => m.role === "user");
    expect(JSON.stringify(userRows.at(-1))).toContain("Shorten the hero");
    expect(
      store.rows.threads.find((t) => t.id === begun.threadId)
        ?.decisionsReportedAt
    ).toEqual(new Date(T0 + 1000));
  });

  it("attaches library images as refs with a note", async () => {
    const { deps, store } = setup();
    const { begun } = await run(
      deps,
      send("what is this", { images: [MEDIA_ID] })
    );
    const text = JSON.stringify(store.rows.messages.get(begun.threadId));
    expect(text).toContain(`media:${MEDIA_ID}`);
    expect(text).toContain("Attached images");
  });
});

describe("beginTurn: site-wide threads and run items", () => {
  const siteRun = async (store: ReturnType<typeof createMemoryAgentStore>) => {
    await store.createThread({
      id: "site1",
      pageId: "p1",
      title: "Site",
      author: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      scope: "site",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    const base: Run = {
      id: "run1",
      threadId: "site1",
      status: "proposed",
      summary: "Refresh",
      items: [],
      costUsd: 0,
      provider: "anthropic",
      model: "claude-opus-5-5",
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      approvedAt: null,
      revertedAt: null,
      revertedBy: null,
      version: 0,
    };
    await store.createRun(base);
    let i = 0;
    const approved = approveRun(
      base,
      newRunItems(
        [{ slug: "services/sample", action: "edit", intent: "Shorten" }],
        () => {
          i += 1;
          return `item${i}`;
        }
      ),
      new Date(T0)
    );
    await store.saveRun({ ...approved, version: 0 });
    return "run1";
  };

  it("a new site-wide message is a planning turn on the site thread", async () => {
    const { deps, store } = setup();
    const { begun, events } = await run(
      deps,
      send("Refresh the services pages", { scope: "site" })
    );
    expect(store.rows.threads.find((t) => t.id === begun.threadId)?.scope).toBe(
      "site"
    );
    expect(events.at(-1)?.type).toBe("done");
  });

  it("runs an item in its own thread, records its end on the run and emits the run", async () => {
    const { deps, store } = setup();
    const runId = await siteRun(store);
    const { events } = await run(deps, {
      body: {
        pageId: "p1",
        threadId: "site1",
        runItem: { runId, itemId: "item1" },
        context,
      },
      userId: "u1",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("run");
    expect(types.at(-1)).toBe("done");
    const itemThreads = store.rows.threads.filter((t) => t.scope === "item");
    expect(itemThreads).toHaveLength(1);
    expect(itemThreads[0]?.title).toContain("/services/sample");
    const after = await store.getRun(runId);
    expect(after?.items[0]?.status).not.toBe("running");
    expect(after?.items[0]?.status).not.toBe("pending");
    // The site thread's lock was released.
    expect(
      store.rows.threads.find((t) => t.id === "site1")?.lockId ?? null
    ).toBeNull();
  });

  it("refuses a run item of an inactive run or one already done", async () => {
    const { deps, store } = setup();
    const runId = await siteRun(store);
    const req = {
      body: {
        pageId: "p1",
        threadId: "site1",
        runItem: { runId, itemId: "item1" },
        context,
      },
      userId: "u1",
    };
    await run(deps, req);
    const again = await refusal(deps, req);
    expect(again.status).toBe(409);
    expect(["ITEM_DONE", "RUN_NOT_ACTIVE"]).toContain(
      again.body.code as string
    );
    const missing = await refusal(deps, {
      ...req,
      body: { ...req.body, runItem: { runId, itemId: "nope" } },
    });
    expect(missing.status).toBe(404);
  });

  it("run items belong to site-wide conversations", async () => {
    const { deps, store } = setup();
    await run(deps, send("hello"));
    const threadId = store.rows.threads[0]!.id;
    const res = await refusal(deps, {
      body: {
        pageId: "p1",
        threadId,
        runItem: { runId: "r", itemId: "i" },
        context,
      },
      userId: "u1",
    });
    expect(res.status).toBe(400);
  });
});
