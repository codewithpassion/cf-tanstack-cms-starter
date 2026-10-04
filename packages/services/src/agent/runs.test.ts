// biome-ignore-all lint/complexity/noVoid: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noReturnAssign: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  approveRun,
  cancelRun,
  newRunItems,
  nextItem,
  type Run,
  startItem,
  threadOfItem,
} from "@repo/cms-core/agent/run";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import { deepEqual } from "@repo/cms-core/ops/json";
import { defaultSiteDoc } from "@repo/cms-core/site/defaults";
import { MEDIA_ID, sampleDoc, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import type { PageDoc } from "@repo/cms-core/types";
import { validatePageDoc } from "@repo/cms-core/validate";
import {
  applyDraftOps,
  checkSlugAvailable,
  createPage,
  getPage,
  listPages,
  publish,
  type ServiceDeps,
} from "../cms/pages-service";
import { createMemoryRepo } from "../testing/memory-repo";
import { type AgentClient, anthropicProvider, EFFORT_BETA } from "./anthropic";
import { loadBudget } from "./budget";
import { runTurn } from "./loop";
import { createMemoryAgentStore } from "./memory-store";
import type { ModelProvider } from "./provider";
import {
  acceptRunChangeset,
  endItem,
  itemMessage,
  mutateRun,
  revertPlan,
  revertRun,
  reviewRunItem,
} from "./runs";
import type { AgentStore, StoredMessage } from "./store-port";
import { duplicateDoc, runTool, type ToolCtx, type ToolDeps } from "./tools";
import { toWorkersAiMessages } from "./workers-ai";

// ---------------------------------------------------------------------------------------------
// Fakes: the page service on the in-memory repo, the agent store in memory.

const T0 = Date.parse("2026-10-02T00:00:00Z");

function setup() {
  let clock = T0;
  let n = 0;
  const store = createMemoryAgentStore();
  const cms: ServiceDeps = {
    // A run proposal's decision is written in the page's commit: the memory repo decides it in the agent store.
    repo: createMemoryRepo({
      decideChangeset: (d) =>
        store.decideNow(d.id, d.status, d.decision, d.decidedAt),
    }).repo,
    kv: (() => {
      const m = new Map<string, string>();
      return {
        get: async (k: string) => m.get(k) ?? null,
        put: async (k: string, v: string) => void m.set(k, v),
        delete: async (k: string) => void m.delete(k),
      };
    })(),
    validate: validatePageDoc,
    labelFor: (t) => t,
    now: () => (clock += 1000),
    genId: () => `id${++n}`,
  };
  const tools: ToolDeps = {
    config: TEST_CONFIG,
    store,
    pageBySlug: (slug) => getPage(cms, { slug }),
    pageById: (id) => getPage(cms, { id }),
    liveDoc: async (page) =>
      page.liveRevId
        ? ((await cms.repo.getRevision(page.liveRevId))?.docJson ?? null)
        : null,
    listPages: () => listPages(cms),
    draftPages: async () => [],
    // propose_seo reads the title template (not in the source).
    siteSeo: async () => defaultSiteDoc(TEST_CONFIG).seo,
    mediaSizes: async () => ({}),
    searchMedia: async () => [],
    getMedia: async () => null,
    pagePerformance: async () => {
      throw new Error("not used");
    },
    gscOverview: async () => {
      throw new Error("not used");
    },
    renderPreview: async () => new Uint8Array([0xff]),
    shareImage: async () => {
      throw new Error("not used");
    },
    putScreenshot: async () => "r2:x",
    previewLink: async ({ page, changesetId }) => ({
      url: `https://test.local/${page.slug}?_preview=t${changesetId ? `&cs=${changesetId}` : ""}`,
      expiresAt: "2026-10-03T01:00:00.000Z",
    }),
    async createDraft(input) {
      await checkSlugAvailable(cms, input.kind, input.slug);
      return createPage(cms, input);
    },
    now: () => clock,
    genId: () => `g${++n}`,
  };
  return {
    cms,
    store,
    tools,
    review: { cms, store, now: () => new Date(clock) },
  };
}

function docAt(slug: string): PageDoc {
  const doc = sampleDoc();
  return {
    ...doc,
    seo: {
      ...doc.seo,
      slug,
      social: { image: { mediaId: MEDIA_ID, alt: "Old share" } },
      canonical: `https://example.com/${slug}`,
    },
  };
}

async function seedPage(
  cms: ServiceDeps,
  slug: string,
  title = "Preview E2E Test"
) {
  return createPage(cms, { kind: "page", slug, title, doc: docAt(slug) });
}

async function siteThread(store: AgentStore) {
  await store.createThread({
    id: "t1",
    pageId: "origin",
    title: "Site",
    author: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    scope: "site",
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
}

async function activeRun(
  store: AgentStore,
  items: Parameters<typeof newRunItems>[0]
): Promise<Run> {
  let i = 0;
  const run: Run = {
    id: "run_1",
    threadId: "t1",
    status: "proposed",
    summary: "Test run",
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
  await store.createRun(run);
  return mutateRun(store, run.id, (r) =>
    approveRun(
      r,
      newRunItems(items, () => `item${++i}`),
      new Date(T0)
    )
  );
}

const ctxFor = (
  scope: ToolCtx["scope"],
  pageId: string | null = null
): ToolCtx => ({
  threadId: "t1",
  pageId,
  counts: { preview: 0, share: 0, create: 0 },
  scope,
  produced: { changesetIds: [], createdPageIds: [] },
});

const body = (out: { content: unknown }) => JSON.parse(out.content as string);

// ---------------------------------------------------------------------------------------------

describe("duplicate_page", () => {
  it("creates a draft copy at the new slug, without the original's share image and canonical", async () => {
    const { cms, tools } = setup();
    const source = await seedPage(cms, "preview-e2e-test");
    const ctx = ctxFor({ kind: "page" }, source.id);
    const out = await runTool(tools, ctx, "duplicate_page", {
      from: "/preview-e2e-test",
      to: "ai-consulting-berlin",
      title: "AI consulting in Berlin",
    });
    expect(out.isError).toBe(false);
    expect(out.created).toMatchObject({
      slug: "ai-consulting-berlin",
      kind: "page",
      title: "AI consulting in Berlin",
    });
    const copy = await getPage(cms, { slug: "ai-consulting-berlin" });
    expect(copy).toMatchObject({
      status: "draft",
      liveRevId: null,
      title: "AI consulting in Berlin",
    });
    expect(copy!.draftDoc!.seo.slug).toBe("ai-consulting-berlin");
    expect(copy!.draftDoc!.seo.social.image).toBeUndefined();
    expect(copy!.draftDoc!.seo.canonical).toBeUndefined();
    expect(copy!.draftDoc!.blocks).toEqual(source.draftDoc!.blocks);
    // The original is untouched.
    expect((await getPage(cms, { id: source.id }))!.draftDoc).toEqual(
      source.draftDoc
    );
    expect(ctx.produced?.createdPageIds).toEqual([copy!.id]);
  });

  it("refuses reserved, taken and malformed slugs and a missing source", async () => {
    const { cms, tools } = setup();
    await seedPage(cms, "preview-e2e-test");
    const code = async (input: Record<string, unknown>) => {
      const out = await runTool(
        tools,
        ctxFor({ kind: "page" }),
        "duplicate_page",
        input
      );
      return out.isError ? body(out).errors[0].code : "ok";
    };
    expect(await code({ from: "preview-e2e-test", to: "admin/berlin" })).toBe(
      "SLUG_RESERVED"
    );
    expect(
      await code({ from: "preview-e2e-test", to: "preview-e2e-test" })
    ).toBe("SLUG_TAKEN");
    expect(await code({ from: "preview-e2e-test", to: "Bad Slug" })).toBe(
      "INVALID_SLUG"
    );
    expect(await code({ from: "preview-e2e-test", to: "blog/x" })).toBe(
      "INVALID_SLUG"
    );
    expect(await code({ from: "nope", to: "fine-slug" })).toBe("NOT_FOUND");
  });

  it("a post copy is re-dated", () => {
    const doc = {
      ...sampleDoc(),
      post: {
        title: "Old",
        excerpt: "",
        author: "D",
        publishedAt: "2020-01-01",
        modifiedAt: "2020-02-01",
        category: "AI",
        tags: [],
        readingTime: 3,
      },
    };
    const copy = duplicateDoc(doc, "blog/copy", "New title", "2026-10-04");
    expect(copy.post).toMatchObject({
      title: "New title",
      publishedAtAuto: true,
    });
    expect(copy.post!.publishedAt).not.toBe("2020-01-01");
    expect(copy.post!.modifiedAt).toBeUndefined();
  });

  it("in a run item: only the item's own copy, once; then the copy is the page it may change", async () => {
    const { cms, store, tools } = setup();
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    const run = await activeRun(store, [
      {
        slug: "ai-consulting-berlin",
        action: "duplicate",
        from: "preview-e2e-test",
        intent: "Berlin",
      },
    ]);
    const ctx = ctxFor({ kind: "item", runId: run.id, item: run.items[0]! });
    const wrong = await runTool(tools, ctx, "duplicate_page", {
      from: "preview-e2e-test",
      to: "ai-consulting-sydney",
    });
    expect(body(wrong).errors[0].code).toBe("WRONG_PAGE");
    const early = await runTool(tools, ctx, "propose_ops", {
      slug: "preview-e2e-test",
      ops: [{ op: "remove", key: "hero1" }],
      summary: "x",
    });
    expect(body(early).errors[0].code).toBe("NOT_ALLOWED");
    const made = await runTool(tools, ctx, "duplicate_page", {
      from: "preview-e2e-test",
      to: "ai-consulting-berlin",
    });
    expect(made.isError).toBe(false);
    expect(ctx.pageId).toBe(made.created!.id);
    const again = await runTool(tools, ctx, "duplicate_page", {
      from: "preview-e2e-test",
      to: "ai-consulting-berlin",
    });
    expect(body(again).errors[0].code).toBe("NOT_ALLOWED");
    const other = await runTool(tools, ctx, "propose_ops", {
      slug: "preview-e2e-test",
      ops: [{ op: "update", key: "hero1", props: { heading: "Berlin" } }],
      summary: "x",
    });
    expect(body(other).errors[0].code).toBe("WRONG_PAGE");
    const staged = await runTool(tools, ctx, "propose_ops", {
      slug: "ai-consulting-berlin",
      ops: [
        {
          op: "update",
          key: "hero1",
          props: { heading: "AI consulting in Berlin" },
        },
      ],
      summary: "Berlin copy",
    });
    expect(staged.isError).toBe(false);
    expect(ctx.produced?.changesetIds).toHaveLength(1);
  });
});

describe("submit_plan", () => {
  it("only in a site-wide planning turn; validates; replaces an unapproved plan", async () => {
    const { cms, store, tools } = setup();
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    const plan = {
      summary: "Two location pages",
      items: [
        {
          slug: "ai-consulting-berlin",
          action: "duplicate",
          from: "preview-e2e-test",
          intent: "Berlin version",
        },
        {
          slug: "ai-consulting-adelaide",
          action: "create",
          intent: "Adelaide page",
        },
      ],
    };
    const inPage = await runTool(
      tools,
      ctxFor({ kind: "page" }),
      "submit_plan",
      plan
    );
    expect(body(inPage).errors[0].code).toBe("NOT_ALLOWED");

    const planning = ctxFor({
      kind: "plan",
      provider: "workers-ai",
      model: "@cf/zai-org/glm-5.3-flash",
    });
    const bad = await runTool(tools, planning, "submit_plan", {
      ...plan,
      items: [{ slug: "admin/berlin", action: "create", intent: "x" }],
    });
    expect(bad.isError).toBe(true);
    expect(body(bad).errors[0]).toMatchObject({
      code: "SLUG_RESERVED",
      path: "items[0].slug",
    });

    const first = await runTool(tools, planning, "submit_plan", plan);
    expect(first.isError).toBe(false);
    expect(first.plan).toMatchObject({
      status: "proposed",
      provider: "workers-ai",
      items: [{ status: "pending" }, { status: "pending" }],
    });
    expect(first.plan!.id.startsWith("run_")).toBe(true);
    const second = await runTool(tools, planning, "submit_plan", plan);
    const runs = await store.listRuns({ threadId: "t1" });
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      [second.plan!.id, "proposed"],
      [first.plan!.id, "superseded"],
    ]);
    // Planning can't change pages.
    const write = await runTool(tools, planning, "propose_ops", {
      slug: "preview-e2e-test",
      ops: [{ op: "remove", key: "hero1" }],
      summary: "x",
    });
    expect(body(write).errors[0].code).toBe("NOT_ALLOWED");
    const create = await runTool(tools, planning, "create_page", {
      kind: "page",
      slug: "x-page",
      title: "X",
    });
    expect(body(create).errors[0].code).toBe("NOT_ALLOWED");
  });
});

describe("review and revert this run", () => {
  /** A run that changed an existing page (accepted) and created a draft copy. */
  async function finishedRun() {
    const env = setup();
    const { cms, store, tools, review } = env;
    const page = await seedPage(cms, "preview-e2e-test");
    await publish(cms, page.id, page.draftVersion);
    await siteThread(store);
    let run = await activeRun(store, [
      { slug: "preview-e2e-test", action: "edit", intent: "New heading" },
      {
        slug: "ai-consulting-berlin",
        action: "duplicate",
        from: "preview-e2e-test",
        intent: "Berlin",
      },
    ]);
    // Item 1 stages a change on the existing page.
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    const c1 = ctxFor(
      { kind: "item", runId: run.id, item: run.items[0]! },
      page.id
    );
    await runTool(tools, c1, "propose_ops", {
      slug: "preview-e2e-test",
      ops: [
        {
          op: "update",
          key: "hero1",
          props: { heading: "Changed by the run" },
        },
      ],
      summary: "New heading",
    });
    run = await endItem(
      { store, cms },
      {
        runId: run.id,
        itemId: "item1",
        threadId: "t1",
        costBefore: 0,
        stopReason: "end_turn",
        produced: c1.produced!,
        pageId: c1.pageId,
      }
    );
    // Item 2 copies it.
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item2", new Date(T0))
    );
    const c2 = ctxFor({ kind: "item", runId: run.id, item: run.items[1]! });
    await runTool(tools, c2, "duplicate_page", {
      from: "preview-e2e-test",
      to: "ai-consulting-berlin",
    });
    run = await endItem(
      { store, cms },
      {
        runId: run.id,
        itemId: "item2",
        threadId: "t1",
        costBefore: 0,
        stopReason: "end_turn",
        produced: c2.produced!,
        pageId: c2.pageId,
      }
    );
    expect(run.status).toBe("done");
    expect(run.items.map((i) => i.status)).toEqual(["proposed", "proposed"]);

    // The user edits the page after the proposal (not in History yet), then accepts from the queue: rejected as a conflict? No, a different block.
    const before = await getPage(cms, { id: page.id });
    await applyDraftOps(cms, page.id, before!.draftVersion, [
      { op: "update", key: "grid1", props: { heading: "My own edit" } },
    ]);
    const preRun = (await getPage(cms, { id: page.id }))!.draftDoc!;
    run = (
      await reviewRunItem(review, {
        runId: run.id,
        itemId: "item1",
        decision: "accept",
      })
    ).run;
    expect(run.items[0]).toMatchObject({ status: "accepted" });
    expect(run.items[0]!.revisionIds).toHaveLength(1);
    run = (
      await reviewRunItem(review, {
        runId: run.id,
        itemId: "item2",
        decision: "accept",
      })
    ).run;
    expect(run.items[1]!.status).toBe("accepted");
    return { ...env, page, run, preRun, copyId: run.items[1]!.createdPageId! };
  }

  it("accepting writes the draft before it and an agent revision tagged with the run, in one commit", async () => {
    const { cms, page, run, preRun } = await finishedRun();
    const after = await getPage(cms, { id: page.id });
    expect(
      (
        after!.draftDoc!.blocks.find((b) => b._key === "hero1")!.props as {
          heading: string;
        }
      ).heading
    ).toBe("Changed by the run");
    const revs = await cms.repo.listRevisions(page.id);
    const agent = await cms.repo.getRevision(run.items[0]!.revisionIds[0]!);
    expect(agent).toMatchObject({ kind: "agent", agentRunId: run.id });
    const parent = await cms.repo.getRevision(agent!.parentRevId!);
    expect(deepEqual(parent!.docJson, preRun)).toBe(true);
    expect(revs.length).toBeGreaterThanOrEqual(3);
    // Nothing was published by the run.
    expect(after!.liveRevId).toBe(page.liveRevId ?? after!.liveRevId);
    expect((await getPage(cms, { slug: "ai-consulting-berlin" }))!.status).toBe(
      "draft"
    );
  });

  it("revert restores exactly (when ticked), archives created drafts, keeps later edits in History, and is idempotent", async () => {
    const { cms, store, review, page, run, preRun, copyId } =
      await finishedRun();
    // An edit after the run's change.
    const now = await getPage(cms, { id: page.id });
    await applyDraftOps(cms, page.id, now!.draftVersion, [
      { op: "update", key: "hero1", props: { lead: "Edited after the run" } },
    ]);
    const afterEdits = (await getPage(cms, { id: page.id }))!.draftDoc!;

    const plan = await revertPlan(review, run);
    expect(plan.map((a) => [a.kind, a.slug])).toEqual([
      ["archive", "ai-consulting-berlin"],
      ["restore", "preview-e2e-test"],
    ]);
    expect(plan[1]).toMatchObject({ laterEdits: true, live: false });

    // The page edited after the run is only restored when ticked.
    const res = await revertRun(review, {
      runId: run.id,
      by: "dom@example.com",
      include: plan.map((a) => a.pageId),
    });
    expect(res.applied).toEqual([copyId, page.id]);
    expect(res.alreadyReverted).toBe(false);
    const restored = await getPage(cms, { id: page.id });
    expect(deepEqual(restored!.draftDoc, preRun)).toBe(true);
    expect((await getPage(cms, { id: copyId }))!.status).toBe("archived");
    const revs = await cms.repo.listRevisions(page.id);
    const latest = await cms.repo.latestRevision(page.id);
    // The restore isn't one of the run's changes.
    expect(latest).toMatchObject({ kind: "restore", agentRunId: null });
    expect(latest!.summary).toMatch(/^Reverted agent run: /);
    // The edit made after the run is kept in History.
    const docs = await Promise.all(revs.map((r) => cms.repo.getRevision(r.id)));
    expect(docs.some((r) => deepEqual(r!.docJson, afterEdits))).toBe(true);
    expect(res.run.revertedAt).not.toBeNull();
    expect(res.run.revertedBy).toBe("dom@example.com");

    // Again: nothing happens.
    const count = revs.length;
    const again = await revertRun(review, {
      runId: run.id,
      by: "dom@example.com",
    });
    expect(again.alreadyReverted).toBe(true);
    expect((await cms.repo.listRevisions(page.id)).length).toBe(count);
    // Its proposals can't be accepted any more.
    await expect(
      reviewRunItem(review, {
        runId: run.id,
        itemId: "item1",
        decision: "accept",
      })
    ).rejects.toThrow(/reverted/);
    expect(await store.getRun(run.id)).toMatchObject({
      revertedBy: "dom@example.com",
    });
  });

  it("a page already back where it was is skipped; a created page published since is left alone", async () => {
    const { cms, review, run, page, preRun, copyId } = await finishedRun();
    const p = await getPage(cms, { id: page.id });
    const restoreOps = [
      {
        op: "update",
        key: "hero1",
        props: {
          heading: (preRun.blocks[0]!.props as { heading: string }).heading,
        },
      },
    ];
    await applyDraftOps(cms, page.id, p!.draftVersion, restoreOps);
    await publish(
      cms,
      copyId,
      (await getPage(cms, { id: copyId }))!.draftVersion
    );
    const plan = await revertPlan(review, run);
    expect(plan.map((a) => a.kind)).toEqual(["skip", "skip"]);
    const res = await revertRun(review, { runId: run.id, by: null });
    expect((await getPage(cms, { id: copyId }))!.status).toBe("published");
    expect(res.actions.every((a) => a.kind === "skip")).toBe(true);
  });

  it("the queue refuses a proposal whose blocks changed since; the editor path applies the chosen blocks", async () => {
    const { cms, store, tools, review } = setup();
    const page = await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    let run = await activeRun(store, [
      { slug: "preview-e2e-test", action: "edit", intent: "x" },
    ]);
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    const ctx = ctxFor(
      { kind: "item", runId: run.id, item: run.items[0]! },
      page.id
    );
    await runTool(tools, ctx, "propose_ops", {
      slug: "preview-e2e-test",
      ops: [
        { op: "update", key: "hero1", props: { heading: "Run heading" } },
        { op: "update", key: "grid1", props: { heading: "Run grid" } },
      ],
      summary: "Two blocks",
    });
    run = await endItem(
      { store, cms },
      {
        runId: run.id,
        itemId: "item1",
        threadId: "t1",
        costBefore: 0,
        stopReason: "end_turn",
        produced: ctx.produced!,
        pageId: page.id,
      }
    );
    const v = (await getPage(cms, { id: page.id }))!.draftVersion;
    await applyDraftOps(cms, page.id, v, [
      { op: "update", key: "hero1", props: { heading: "Mine" } },
    ]);
    await expect(
      reviewRunItem(review, {
        runId: run.id,
        itemId: "item1",
        decision: "accept",
      })
    ).rejects.toThrow(/changed since/);
    const fresh = await getPage(cms, { id: page.id });
    const res = await acceptRunChangeset(review, {
      changesetId: run.items[0]!.changesetIds[0]!,
      groups: ["grid1"],
      draftVersion: fresh!.draftVersion,
    });
    const doc = (await getPage(cms, { id: page.id }))!.draftDoc!;
    expect(
      (doc.blocks.find((b) => b._key === "hero1")!.props as { heading: string })
        .heading
    ).toBe("Mine");
    expect(
      (doc.blocks.find((b) => b._key === "grid1")!.props as { heading: string })
        .heading
    ).toBe("Run grid");
    expect(res.run.items[0]).toMatchObject({ status: "accepted" });
    expect(
      (await store.getChangeset(run.items[0]!.changesetIds[0]!))!.status
    ).toBe("partial");
  });

  it("rejecting from the queue archives the draft the item created", async () => {
    const { cms, store, tools, review } = setup();
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    let run = await activeRun(store, [
      { slug: "ai-consulting-adelaide", action: "create", intent: "x" },
    ]);
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    const ctx = ctxFor({ kind: "item", runId: run.id, item: run.items[0]! });
    const made = await runTool(tools, ctx, "create_page", {
      kind: "page",
      slug: "ai-consulting-adelaide",
      title: "Adelaide",
    });
    expect(made.isError).toBe(false);
    run = await endItem(
      { store, cms },
      {
        runId: run.id,
        itemId: "item1",
        threadId: "t1",
        costBefore: 0,
        stopReason: "end_turn",
        produced: ctx.produced!,
        pageId: ctx.pageId,
      }
    );
    run = (
      await reviewRunItem(review, {
        runId: run.id,
        itemId: "item1",
        decision: "reject",
      })
    ).run;
    expect(run.items[0]!.status).toBe("rejected");
    expect((await getPage(cms, { id: made.created!.id }))!.status).toBe(
      "archived"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Budget across a run: each item runs in its own thread, so the thread cap applies per item and
// the run cap (and the day's) across the run.

function message(
  content: BetaMessage["content"],
  stop: BetaMessage["stop_reason"],
  inputTokens: number
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
      input_tokens: inputTokens,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

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
              for (const [index, block] of msg.content.entries()) {
                yield {
                  type: "content_block_start",
                  index,
                  content_block: block,
                } as BetaRawMessageStreamEvent;
                yield {
                  type: "content_block_stop",
                  index,
                } as BetaRawMessageStreamEvent;
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

/** Runs one item the way the agent route does: its own thread, the site thread's lock aside, budget per item thread and per run. */
function itemRunner(
  env: ReturnType<typeof setup>,
  client: AgentClient,
  events: AgentEvent[] = []
) {
  const { cms, store, tools } = env;
  return async (runId: string, itemId: string) => {
    let run = await mutateRun(store, runId, (r) =>
      startItem(r, itemId, new Date(T0))
    );
    const item = run.items.find((i) => i.id === itemId)!;
    const threadId = threadOfItem(run, itemId);
    if (!(await store.getThread(threadId))) {
      await store.createThread({
        id: threadId,
        pageId: "origin",
        title: item.slug,
        author: null,
        createdAt: new Date(T0),
        updatedAt: new Date(T0),
        scope: "item",
        provider: "anthropic",
        model: "claude-opus-5-5",
      });
    }
    const costBefore = await store.threadCost(threadId);
    const runCostBefore = run.costUsd;
    const budget = async () =>
      loadBudget(store, threadId, T0 + 60_000, {
        id: runId,
        spentUsd:
          runCostBefore +
          Math.max(0, (await store.threadCost(threadId)) - costBefore),
      });
    const loop = {
      provider: anthropicProvider(
        client,
        async (c: unknown) => c as never,
        TEST_CONFIG
      ),
      store,
      tools,
      emit: (e: AgentEvent) => events.push(e),
      budget,
      now: () => T0 + 60_000,
    };
    const target =
      item.createdPageId ??
      (item.action === "edit" || item.action === "seo"
        ? (await getPage(cms, { slug: item.slug }))?.id
        : undefined) ??
      null;
    const produced = {
      changesetIds: [] as string[],
      createdPageIds: [] as string[],
    };
    let stopReason: string | null = "error";
    let error: string | undefined;
    let pageId = target;
    try {
      const res = await runTurn(loop, {
        threadId,
        pageId: target,
        scope: { kind: "item", runId, item },
        user: itemMessage(run, item, null),
        context: "item context",
        produced,
      });
      stopReason = res.stopReason;
      pageId = res.ctx.pageId;
    } catch (err) {
      error = String(err);
    }
    run = await endItem(
      { store, cms },
      {
        runId,
        itemId,
        threadId,
        costBefore,
        stopReason,
        produced,
        pageId,
        ...(error && { error }),
      }
    );
    return { run, stopReason, threadId };
  };
}

describe("budget across a run", () => {
  it("the thread cap applies per item thread; the run cap pauses the next item (back to pending), raising it resumes; the run total adds up", async () => {
    const env = setup();
    const { cms, store } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    await store.saveSettings(
      { threadCapUsd: 5, dailyCapUsd: null },
      null,
      new Date(T0)
    );
    let run = await activeRun(store, [
      { slug: "ai-consulting-berlin", action: "create", intent: "Berlin" },
      { slug: "ai-consulting-adelaide", action: "create", intent: "Adelaide" },
      { slug: "ai-consulting-hobart", action: "create", intent: "Hobart" },
    ]);
    const { client, requests } = fakeClient([
      // Item 1: 1,000,000 input tokens per call at $4/MTok = $4 each: its own thread goes over its $5 cap ($8).
      message(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-berlin",
              title: "Berlin",
            },
          } as never,
        ],
        "tool_use",
        1_000_000
      ),
      message(
        [{ type: "text", text: "Created the Berlin draft." } as never],
        "end_turn",
        1_000_000
      ),
      // Item 2: a fresh thread, so its thread cap isn't reached; the run reaches $16 of its $15.
      message(
        [
          {
            type: "tool_use",
            id: "tu2",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-adelaide",
              title: "Adelaide",
            },
          } as never,
        ],
        "tool_use",
        1_000_000
      ),
      message(
        [{ type: "text", text: "Created the Adelaide draft." } as never],
        "end_turn",
        1_000_000
      ),
      // Item 3, after the run's cap is raised.
      message(
        [
          {
            type: "tool_use",
            id: "tu3",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-hobart",
              title: "Hobart",
            },
          } as never,
        ],
        "tool_use",
        1000
      ),
      message(
        [{ type: "text", text: "Created the Hobart draft." } as never],
        "end_turn",
        1000
      ),
    ]);
    const events: AgentEvent[] = [];
    const runItem = itemRunner(env, client, events);

    const first = await runItem(run.id, "item1");
    expect(first.stopReason).toBe("end_turn");
    expect(first.threadId).toBe(`${run.id}~1`);
    run = first.run;
    expect(run.items[0]).toMatchObject({ status: "proposed" });
    expect(await store.threadCost(first.threadId)).toBeGreaterThan(5);
    // The site thread holds none of it.
    expect(await store.messages("t1")).toEqual([]);

    const second = await runItem(run.id, "item2");
    run = second.run;
    expect(second.stopReason).toBe("end_turn");
    expect(run.items[1]).toMatchObject({ status: "proposed" });
    // A fresh transcript: item 2's first request doesn't carry item 1's turn.
    expect(requests[2]!.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
    ]);
    expect(JSON.stringify(requests[2]!.messages)).not.toContain(
      "Created the Berlin draft"
    );

    // The run cap ($15) is reached before item 3's first call: it pauses and goes back to pending.
    const third = await runItem(run.id, "item3");
    run = third.run;
    expect(third.stopReason).toBe("budget");
    expect(run.items[2]).toMatchObject({ status: "pending", attempts: 1 });
    expect(requests).toHaveLength(4);
    const paused = events
      .filter(
        (e): e is Extract<AgentEvent, { type: "budget" }> => e.type === "budget"
      )
      .at(-1)!;
    expect(paused.budget).toMatchObject({
      blocked: "run",
      threadId: third.threadId,
      run: { runId: run.id },
    });

    // Raise the run's cap: the next attempt runs.
    await store.addOverride({
      id: "o1",
      scope: "run",
      threadId: run.id,
      day: null,
      amountUsd: 5,
      createdBy: "dom",
      createdAt: new Date(T0).toISOString(),
    });
    run = (await runItem(run.id, "item3")).run;
    expect(run.items[2]).toMatchObject({ status: "proposed", attempts: 2 });
    expect(run.status).toBe("done");
    const total = (
      await Promise.all(
        [1, 2, 3].map((n) => store.threadCost(`${run.id}~${n}`))
      )
    ).reduce((a, b) => a + b, 0);
    expect(run.costUsd).toBeCloseTo(total, 6);
    expect(run.items.reduce((s, i) => s + i.costUsd, 0)).toBeCloseTo(
      run.costUsd,
      6
    );
    // The item's message carries the approved intent and the plan.
    const firstUser = JSON.stringify(requests[0]!.messages[0]!);
    expect(firstUser).toContain(
      "[Run item 1 of 3: create /ai-consulting-berlin]"
    );
    expect(firstUser).toContain("The approved plan: Test run");
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 6 review fixes (ported from the review probes, as assertions).

/** An edit item with one staged ops changeset (and optionally an SEO one), ended and proposed. */
async function proposedEdit(
  env: ReturnType<typeof setup>,
  opts: { seo?: boolean } = {}
) {
  const { cms, store, tools } = env;
  const page = await seedPage(cms, "preview-e2e-test");
  await siteThread(store);
  let run = await activeRun(store, [
    { slug: "preview-e2e-test", action: "edit", intent: "x" },
  ]);
  run = await mutateRun(store, run.id, (r) =>
    startItem(r, "item1", new Date(T0))
  );
  const ctx = ctxFor(
    { kind: "item", runId: run.id, item: run.items[0]! },
    page.id
  );
  const a = await runTool(tools, ctx, "propose_ops", {
    slug: "preview-e2e-test",
    ops: [{ op: "update", key: "hero1", props: { heading: "Run heading" } }],
    summary: "h",
  });
  expect(a.isError).toBe(false);
  if (opts.seo) {
    const s = await runTool(tools, ctx, "propose_seo", {
      slug: "preview-e2e-test",
      seo: { focusKeyphrase: "ai consulting" },
      variants: [
        {
          title: "Consulting Berlin | Acme",
          description:
            "A description that is long enough to be a reasonable meta description for the page here ok.",
        },
        {
          title: "Consulting in Berlin | Acme",
          description:
            "Another description that is long enough to be a reasonable meta description for this page ok.",
        },
      ],
    });
    expect(s.isError).toBe(false);
  }
  run = await endItem(
    { store, cms },
    {
      runId: run.id,
      itemId: "item1",
      threadId: "t1",
      costBefore: 0,
      stopReason: "end_turn",
      produced: ctx.produced!,
      pageId: page.id,
    }
  );
  return { page, run };
}

const headingOf = (doc: PageDoc, key: string) =>
  (doc.blocks.find((b) => b._key === key)!.props as { heading: string })
    .heading;

describe("revert: edits made after the run (H2)", () => {
  it("probe A: a user edit between two accepted changesets of one item survives a default revert", async () => {
    const env = setup();
    const { cms, store, review } = env;
    const { page, run: proposed } = await proposedEdit(env, { seo: true });
    const [opsId, seoId] = proposed.items[0]!.changesetIds as [string, string];
    await acceptRunChangeset(review, {
      changesetId: opsId,
      draftVersion: (await getPage(cms, { id: page.id }))!.draftVersion,
    });
    await applyDraftOps(
      cms,
      page.id,
      (await getPage(cms, { id: page.id }))!.draftVersion,
      [{ op: "update", key: "grid1", props: { heading: "USER EDIT BETWEEN" } }]
    );
    await acceptRunChangeset(review, {
      changesetId: seoId,
      draftVersion: (await getPage(cms, { id: page.id }))!.draftVersion,
      variant: 0,
    });
    const run = (await store.getRun(proposed.id))!;

    const plan = await revertPlan(review, run);
    expect(plan).toEqual([
      expect.objectContaining({
        kind: "restore",
        pageId: page.id,
        laterEdits: true,
      }),
    ]);
    const res = await revertRun(review, { runId: run.id, by: null });
    expect(res.applied).toEqual([]);
    const doc = (await getPage(cms, { id: page.id }))!.draftDoc!;
    expect(headingOf(doc, "grid1")).toBe("USER EDIT BETWEEN");
    expect(res.run.revertedAt).not.toBeNull();
  });

  it("a page nobody touched after the run is restored by default; ticking a later-edited page restores it too", async () => {
    const env = setup();
    const { cms, review } = env;
    const { page, run } = await proposedEdit(env);
    const before = (await getPage(cms, { id: page.id }))!.draftDoc!;
    await acceptRunChangeset(review, {
      changesetId: run.items[0]!.changesetIds[0]!,
      draftVersion: (await getPage(cms, { id: page.id }))!.draftVersion,
    });
    const plan = await revertPlan(review, (await env.store.getRun(run.id))!);
    expect(plan).toEqual([
      expect.objectContaining({
        kind: "restore",
        laterEdits: false,
        live: false,
      }),
    ]);
    const res = await revertRun(review, { runId: run.id, by: null });
    expect(res.applied).toEqual([page.id]);
    expect(
      deepEqual((await getPage(cms, { id: page.id }))!.draftDoc, before)
    ).toBe(true);
  });

  it("targets come from revisions tagged with the run, not the run record; pages whose run changes are live say so", async () => {
    const env = setup();
    const { cms, store, review } = env;
    const { page, run } = await proposedEdit(env);
    await acceptRunChangeset(review, {
      changesetId: run.items[0]!.changesetIds[0]!,
      draftVersion: (await getPage(cms, { id: page.id }))!.draftVersion,
    });
    const p = (await getPage(cms, { id: page.id }))!;
    await publish(cms, page.id, p.draftVersion);
    // The run record lost its revision ids: the revisions are the source of truth.
    await mutateRun(store, run.id, (r) => ({
      ...r,
      items: r.items.map((i) => ({ ...i, revisionIds: [] })),
    }));
    const plan = await revertPlan(review, (await store.getRun(run.id))!);
    expect(plan).toEqual([
      expect.objectContaining({
        kind: "restore",
        pageId: page.id,
        live: true,
        laterEdits: true,
      }),
    ]);
  });
});

describe("revert: locking and runs still working (M1, lows)", () => {
  it("is refused while the site thread's turn lock is held; an item left running by a dead request is skipped", async () => {
    const env = setup();
    const { cms, store, review } = env;
    const { page, run } = await proposedEdit(env);
    await acceptRunChangeset(review, {
      changesetId: run.items[0]!.changesetIds[0]!,
      draftVersion: (await getPage(cms, { id: page.id }))!.draftVersion,
    });
    // Another item, left running.
    await mutateRun(store, run.id, (r) => ({
      ...r,
      status: "active",
      items: [
        ...r.items,
        {
          ...r.items[0]!,
          id: "item2",
          status: "running",
          changesetIds: [],
          revisionIds: [],
        },
      ],
    }));
    expect((await store.acquireLock("t1", "other-tab", new Date())).ok).toBe(
      true
    );
    await expect(
      revertRun(review, { runId: run.id, by: null })
    ).rejects.toThrow(/busy/);
    expect((await store.getRun(run.id))!.revertedAt).toBeNull();
    await store.releaseLock("t1", "other-tab");
    const res = await revertRun(review, { runId: run.id, by: null });
    expect(res.run).toMatchObject({
      status: "cancelled",
      revertedAt: expect.any(String),
    });
    expect(res.run.items[1]).toMatchObject({ status: "skipped" });
    // The lock is released again.
    expect((await store.getThread("t1"))!.lockId ?? null).toBeNull();
  });

  it("an item that ends after its run was reverted or cancelled: its proposals are rejected and its draft archived, nothing stays pending", async () => {
    const env = setup();
    const { cms, store, tools } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    let run = await activeRun(store, [
      {
        slug: "ai-consulting-berlin",
        action: "duplicate",
        from: "preview-e2e-test",
        intent: "Berlin",
      },
      { slug: "ai-consulting-adelaide", action: "create", intent: "Adelaide" },
    ]);
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    const ctx = ctxFor({ kind: "item", runId: run.id, item: run.items[0]! });
    const made = await runTool(tools, ctx, "duplicate_page", {
      from: "preview-e2e-test",
      to: "ai-consulting-berlin",
    });
    await runTool(tools, ctx, "propose_ops", {
      slug: "ai-consulting-berlin",
      ops: [{ op: "update", key: "hero1", props: { heading: "Berlin" } }],
      summary: "Berlin",
    });
    // Cancelled from another tab while the item runs.
    run = await mutateRun(store, run.id, (r) => cancelRun(r));
    run = await endItem(
      { store, cms },
      {
        runId: run.id,
        itemId: "item1",
        threadId: "t1",
        costBefore: 0,
        stopReason: "end_turn",
        produced: ctx.produced!,
        pageId: ctx.pageId,
      }
    );
    expect(run.status).toBe("cancelled");
    expect(run.items.map((i) => i.status)).toEqual(["skipped", "skipped"]);
    expect(run.items[0]!.note).toMatch(
      /cancelled while this page was running; what it staged was rejected/
    );
    expect(
      (await store.changesetsByIds(run.items[0]!.changesetIds)).map(
        (c) => c.status
      )
    ).toEqual(["rejected"]);
    expect((await getPage(cms, { id: made.created!.id }))!.status).toBe(
      "archived"
    );
  });
});

describe("accepting a run proposal (M3, M4)", () => {
  it("decides the proposal in the page's commit: one already decided writes nothing", async () => {
    const env = setup();
    const { cms, store, review } = env;
    const { page, run } = await proposedEdit(env);
    const id = run.items[0]!.changesetIds[0]!;
    const before = await getPage(cms, { id: page.id });
    const revsBefore = (await cms.repo.listRevisions(page.id)).length;
    // Decided by another tab after this one looked (the status check passed already).
    const getChangeset = store.getChangeset.bind(store);
    store.getChangeset = async (x) => {
      const row = await getChangeset(x);
      store.decideNow(
        id,
        "rejected",
        { accepted: [], rejected: ["hero1"] },
        new Date()
      );
      return row;
    };
    await expect(
      acceptRunChangeset(review, {
        changesetId: id,
        draftVersion: before!.draftVersion,
      })
    ).rejects.toThrow(/already decided/);
    store.getChangeset = getChangeset;
    const after = await getPage(cms, { id: page.id });
    expect(after!.draftVersion).toBe(before!.draftVersion);
    expect((await cms.repo.listRevisions(page.id)).length).toBe(revsBefore);
    expect((await store.getChangeset(id))!.status).toBe("rejected");
  });

  it("an accepted proposal records the revision it became, written with the page", async () => {
    const env = setup();
    const { cms, store, review } = env;
    const { page, run } = await proposedEdit(env);
    const id = run.items[0]!.changesetIds[0]!;
    const res = await acceptRunChangeset(review, {
      changesetId: id,
      draftVersion: (await getPage(cms, { id: page.id }))!.draftVersion,
    });
    expect((await store.getChangeset(id))!).toMatchObject({
      status: "accepted",
      decision: { accepted: ["hero1"], rejected: [], revId: res.revId },
    });
  });

  it("the editor path refuses blocks changed since the proposal unless the user kept them knowingly", async () => {
    const env = setup();
    const { cms, review } = env;
    const { page, run } = await proposedEdit(env);
    const id = run.items[0]!.changesetIds[0]!;
    await applyDraftOps(
      cms,
      page.id,
      (await getPage(cms, { id: page.id }))!.draftVersion,
      [{ op: "update", key: "hero1", props: { heading: "Mine" } }]
    );
    const v = (await getPage(cms, { id: page.id }))!.draftVersion;
    await expect(
      acceptRunChangeset(review, { changesetId: id, draftVersion: v })
    ).rejects.toThrow(/You changed 1 of the chosen block/);
    await expect(
      acceptRunChangeset(review, {
        changesetId: id,
        draftVersion: v - 1,
        confirmConflicts: ["hero1"],
      })
    ).rejects.toThrow(/review it again/);
    await acceptRunChangeset(review, {
      changesetId: id,
      draftVersion: v,
      confirmConflicts: ["hero1"],
    });
    expect(
      headingOf((await getPage(cms, { id: page.id }))!.draftDoc!, "hero1")
    ).toBe("Run heading");
  });

  it("the queue's Accept needs the SEO option when the item has an SEO proposal", async () => {
    const env = setup();
    const { cms, review } = env;
    const { page, run } = await proposedEdit(env, { seo: true });
    await expect(
      reviewRunItem(review, {
        runId: run.id,
        itemId: "item1",
        decision: "accept",
      })
    ).rejects.toThrow(/Choose which title/);
    // Nothing was applied.
    expect(
      headingOf((await getPage(cms, { id: page.id }))!.draftDoc!, "hero1")
    ).not.toBe("Run heading");
    const done = await reviewRunItem(review, {
      runId: run.id,
      itemId: "item1",
      decision: "accept",
      variant: 1,
    });
    expect(done.run.items[0]!.status).toBe("accepted");
    expect((await getPage(cms, { id: page.id }))!.draftDoc!.seo.title).toBe(
      "Consulting in Berlin | Acme"
    );
  });
});

describe("a failed turn keeps what it produced (H1)", () => {
  it("probe B: a turn that throws after create_page leaves the item proposed with its draft, still reviewable", async () => {
    const env = setup();
    const { cms, store } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    let run = await activeRun(store, [
      { slug: "ai-consulting-berlin", action: "create", intent: "Berlin" },
    ]);
    const { client } = fakeClient([
      // The second call fails (no more scripted responses): the turn throws after creating the draft.
      message(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-berlin",
              title: "Berlin",
            },
          } as never,
        ],
        "tool_use",
        1000
      ),
    ]);
    const res = await itemRunner(env, client)(run.id, "item1");
    run = res.run;
    const draft = await getPage(cms, { slug: "ai-consulting-berlin" });
    expect(draft!.status).toBe("draft");
    expect(run.items[0]).toMatchObject({
      status: "proposed",
      createdPageId: draft!.id,
      pageId: draft!.id,
    });
    expect(run.items[0]!.note).toMatch(
      /no more scripted responses.*What it staged before that is in the review queue/
    );

    // Still reviewable: rejecting archives the draft.
    const rejected = await reviewRunItem(env.review, {
      runId: run.id,
      itemId: "item1",
      decision: "reject",
    });
    expect(rejected.run.items[0]!.status).toBe("rejected");
    expect((await getPage(cms, { id: draft!.id }))!.status).toBe("archived");
  });

  it("an interrupted item runs again on its existing draft: no SLUG_TAKEN dead end", async () => {
    const env = setup();
    const { cms, store } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    const run = await activeRun(store, [
      { slug: "ai-consulting-berlin", action: "create", intent: "Berlin" },
    ]);
    const { client, requests } = fakeClient([
      message(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-berlin",
              title: "Berlin",
              blocks: [
                {
                  _type: "hero",
                  _key: "berlinhero1",
                  props: { variant: "page", heading: "Berlin" },
                },
              ],
            },
          } as never,
        ],
        "tool_use",
        1000
      ),
      message(
        [
          {
            type: "tool_use",
            id: "tu2",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-berlin",
              title: "Berlin",
            },
          } as never,
        ],
        "max_tokens",
        1000
      ),
      // Second attempt: the model tries to create it again, then changes it.
      message(
        [
          {
            type: "tool_use",
            id: "tu3",
            name: "create_page",
            input: {
              kind: "page",
              slug: "ai-consulting-berlin",
              title: "Berlin",
            },
          } as never,
        ],
        "tool_use",
        1000
      ),
      message(
        [
          {
            type: "tool_use",
            id: "tu4",
            name: "propose_ops",
            input: {
              slug: "ai-consulting-berlin",
              ops: [
                {
                  op: "update",
                  key: "berlinhero1",
                  props: { heading: "AI consulting in Berlin" },
                },
              ],
              summary: "Berlin",
            },
          } as never,
        ],
        "tool_use",
        1000
      ),
      message([{ type: "text", text: "Done." } as never], "end_turn", 1000),
    ]);
    const runItem = itemRunner(env, client);
    // The first attempt is cut off after creating the draft; it is run again (as on resume after an interruption).
    const first = await runItem(run.id, "item1");
    expect(first.run.items[0]).toMatchObject({ status: "proposed" });
    await mutateRun(store, run.id, (r) => ({
      ...r,
      status: "active",
      items: r.items.map((i) => ({ ...i, status: "pending" as const })),
    }));
    const second = await runItem(run.id, "item1");
    const tu3 = JSON.stringify(requests[3]!.messages.at(-1));
    expect(tu3).toContain("already exists; change it with propose_ops");
    expect(tu3).not.toContain("SLUG_TAKEN");
    expect(second.run.items[0]).toMatchObject({
      status: "proposed",
      attempts: 2,
    });
    expect(second.run.items[0]!.changesetIds).toHaveLength(1);
    // Both attempts wrote to the item's own thread.
    expect(
      (await store.messages(first.threadId)).filter(
        (m) => m.role === "assistant"
      )
    ).toHaveLength(5);
  });

  it("a draft created by an attempt that died before it was recorded is adopted on retry instead of SLUG_TAKEN", async () => {
    const env = setup();
    const { cms, store, tools } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    let run = await activeRun(store, [
      { slug: "ai-consulting-berlin", action: "create", intent: "Berlin" },
    ]);
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    // The draft exists, but the run never heard of it.
    const orphan = await createPage(cms, {
      kind: "page",
      slug: "ai-consulting-berlin",
      title: "Berlin",
      doc: docAt("ai-consulting-berlin"),
    });
    const ctx = ctxFor({ kind: "item", runId: run.id, item: run.items[0]! });
    const out = await runTool(tools, ctx, "create_page", {
      kind: "page",
      slug: "ai-consulting-berlin",
      title: "Berlin",
    });
    expect(out.isError).toBe(false);
    expect(body(out)).toMatchObject({
      ok: true,
      id: orphan.id,
      reused: expect.stringContaining("earlier attempt"),
    });
    expect(ctx.pageId).toBe(orphan.id);
    expect((await store.getRun(run.id))!.items[0]).toMatchObject({
      createdPageId: orphan.id,
    });
    // A user's page at another item's slug that was edited is not adopted.
    const edited = await createPage(cms, {
      kind: "page",
      slug: "ai-consulting-hobart",
      title: "Hobart",
      doc: docAt("ai-consulting-hobart"),
    });
    await applyDraftOps(cms, edited.id, 0, [
      { op: "update", key: "hero1", props: { heading: "Mine" } },
    ]);
    let run2 = await activeRun2(store, [
      { slug: "ai-consulting-hobart", action: "create", intent: "Hobart" },
    ]);
    run2 = await mutateRun(store, run2.id, (r) =>
      startItem(r, run2.items[0]!.id, new Date(T0))
    );
    const out2 = await runTool(
      tools,
      ctxFor({ kind: "item", runId: run2.id, item: run2.items[0]! }),
      "create_page",
      { kind: "page", slug: "ai-consulting-hobart", title: "Hobart" }
    );
    expect(body(out2).errors[0].code).toBe("SLUG_TAKEN");
  });

  it("tools record what they stage on the run at once", async () => {
    const env = setup();
    const { store } = env;
    const { run } = await proposedEdit(env);
    // proposedEdit's endItem merged the same ids: no duplicates.
    expect(run.items[0]!.changesetIds).toHaveLength(1);
    expect((await store.getRun(run.id))!.items[0]!.changesetIds).toEqual(
      run.items[0]!.changesetIds
    );
  });
});

/** A second run in the same thread (a different id). */
async function activeRun2(
  store: AgentStore,
  items: Parameters<typeof newRunItems>[0]
): Promise<Run> {
  let i = 0;
  const run: Run = {
    ...(await store.getRun("run_1"))!,
    id: "run_2",
    status: "proposed",
    items: [],
    version: 0,
  };
  await store.createRun(run);
  return mutateRun(store, run.id, (r) =>
    approveRun(
      r,
      newRunItems(items, () => `run2item${++i}`),
      new Date(T0 + 120_000)
    )
  );
}

describe("duplicate_page (lows)", () => {
  it("copies the live version of a published page, noindex, with a 'Copy of' title", async () => {
    const { cms, tools } = setup();
    const source = await seedPage(cms, "preview-e2e-test");
    await publish(cms, source.id, source.draftVersion);
    const live = (await getPage(cms, { id: source.id }))!.draftDoc!;
    // An unpublished draft edit: not copied.
    await applyDraftOps(
      cms,
      source.id,
      (await getPage(cms, { id: source.id }))!.draftVersion,
      [{ op: "update", key: "hero1", props: { heading: "Unpublished edit" } }]
    );
    const out = await runTool(
      tools,
      ctxFor({ kind: "page" }, source.id),
      "duplicate_page",
      { from: "preview-e2e-test", to: "ai-consulting-berlin" }
    );
    expect(body(out)).toMatchObject({
      ok: true,
      copiedVersion: "live (published)",
      title: "Copy of Preview E2E Test",
    });
    const copy = (await getPage(cms, { slug: "ai-consulting-berlin" }))!;
    expect(headingOf(copy.draftDoc!, "hero1")).toBe(headingOf(live, "hero1"));
    expect(copy.draftDoc!.seo.robots.index).toBe(false);
    expect(copy.draftDoc!.seo.title).toBe(`Copy of ${live.seo.title}`);
  });
});

describe("Pause / cancel (lows)", () => {
  it("cancelling while an item runs leaves no pending item", async () => {
    const env = setup();
    const { cms, store } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    let run = await activeRun(store, [
      { slug: "ai-consulting-berlin", action: "create", intent: "Berlin" },
      { slug: "ai-consulting-adelaide", action: "create", intent: "Adelaide" },
    ]);
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    run = await mutateRun(store, run.id, (r) => cancelRun(r));
    // The running turn was stopped: interrupted outcomes don't go back to pending on a cancelled run.
    run = await endItem(
      { store, cms },
      {
        runId: run.id,
        itemId: "item1",
        threadId: "t1",
        costBefore: 0,
        stopReason: "stopped",
        produced: { changesetIds: [], createdPageIds: [] },
        pageId: null,
      }
    );
    expect(run.items.map((i) => i.status)).toEqual(["skipped", "skipped"]);
    expect(nextItem(run, { threadBusy: false })).toBeNull();
  });
});

describe("per-message effort and the cached prefix", () => {
  it("planning raises effort with one stored effort row; plan and item requests share the request prefix; history is append-only", async () => {
    const env = setup();
    const { cms, store, tools } = env;
    await seedPage(cms, "preview-e2e-test");
    await siteThread(store);
    const { client, requests } = fakeClient([
      message(
        [{ type: "text", text: "Here is a plan." } as never],
        "end_turn",
        100
      ),
      message(
        [{ type: "text", text: "Still planning." } as never],
        "end_turn",
        100
      ),
      message(
        [{ type: "text", text: "Nothing to change here." } as never],
        "end_turn",
        100
      ),
    ]);
    const loop = {
      provider: anthropicProvider(
        client,
        async (c: unknown) => c as never,
        TEST_CONFIG
      ),
      store,
      tools,
      emit: () => {},
      now: () => T0,
    };
    const plan = {
      kind: "plan" as const,
      provider: "anthropic" as const,
      model: "claude-opus-5-5",
    };
    await runTurn(loop, {
      threadId: "t1",
      pageId: null,
      scope: plan,
      user: "Plan two location pages",
      context: "plan context",
      effort: "high",
    });
    await runTurn(loop, {
      threadId: "t1",
      pageId: null,
      scope: plan,
      user: "And a third",
      context: "plan context",
      effort: "high",
    });
    let run = await activeRun(store, [
      { slug: "preview-e2e-test", action: "edit", intent: "x" },
    ]);
    run = await mutateRun(store, run.id, (r) =>
      startItem(r, "item1", new Date(T0))
    );
    await store.createThread({
      id: threadOfItem(run, "item1"),
      pageId: "origin",
      title: "item",
      author: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      scope: "item",
    });
    await runTurn(loop, {
      threadId: threadOfItem(run, "item1"),
      pageId: null,
      scope: { kind: "item", runId: run.id, item: run.items[0]! },
      user: "item",
      context: "item context",
    });

    const [p1, p2, item] = requests as [
      (typeof requests)[number],
      (typeof requests)[number],
      (typeof requests)[number],
    ];
    // The effort row: once, first in the plan thread, in the documented wire shape.
    expect(p1.messages[0]!).toEqual({
      role: "system",
      content: [],
      output_config: { effort: "high" },
    });
    expect(
      p2.messages.filter(
        (m) => (m as { output_config?: unknown }).output_config
      )
    ).toHaveLength(1);
    // The item thread runs at the request's default (no effort row).
    expect(
      item.messages.some(
        (m) => (m as { output_config?: unknown }).output_config
      )
    ).toBe(false);
    // Request-level parameters (tools, system, model, effort, thinking, betas) are identical for every request.
    const { messages: _1, ...b1 } = p1;
    const { messages: _2, ...b2 } = p2;
    const { messages: _3, ...b3 } = item;
    expect(b2).toEqual(b1);
    expect(b3).toEqual(b1);
    expect(b1.output_config).toEqual({ effort: "medium" });
    expect(b1.betas).toContain(EFFORT_BETA);
    // Append-only: the second planning request starts with the first one's messages.
    expect(p2.messages.slice(0, p1.messages.length)).toEqual(p1.messages);
  });

  it("a provider without per-message effort gets no effort row; Workers AI skips a stored one", async () => {
    const env = setup();
    const { store, tools } = env;
    await siteThread(store);
    const seen: StoredMessage[][] = [];
    const provider: ModelProvider = {
      id: "workers-ai",
      model: "@cf/zai-org/glm-5.3-flash",
      async step(input) {
        seen.push(structuredClone(input.rows));
        return {
          assistant: {
            content: { content: "ok" },
            model: "glm",
            stopReason: "stop",
            usage: {},
            costUsd: 0,
          },
          calls: [],
          stop: "end",
          stopReason: "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          } as never,
        };
      },
      toolResultRows: () => [],
    };
    await runTurn(
      { provider, store, tools, emit: () => {} },
      {
        threadId: "t1",
        pageId: null,
        user: "Plan",
        context: "plan context",
        effort: "high",
      }
    );
    expect(seen[0]!.map((r) => r.role)).toEqual(["user", "system"]);
    const wai = await toWorkersAiMessages(
      [
        {
          seq: 0,
          role: "system",
          content: { output_config: { effort: "high" } },
          createdAt: new Date(),
        },
        { seq: 1, role: "user", content: "hi", createdAt: new Date() },
      ],
      async (c) => c as never
    );
    expect(wai).toEqual([{ role: "user", content: "hi" }]);
  });
});
