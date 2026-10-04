// biome-ignore-all lint/complexity/noVoid: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/noAwaitInLoops: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noExportsInTest: ported verbatim; the source exports the setup helpers from the test (kept diffable).
// biome-ignore-all lint/suspicious/noMisplacedAssertion: ported verbatim from the source test (kept diffable); the helper asserts on behalf of its callers.
// biome-ignore-all lint/suspicious/noReturnAssign: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning fakes; kept as in the source.
import { describe, expect, it, spyOn } from "bun:test";
import { defaultSiteDoc } from "@repo/cms-core/site/defaults";
import { sampleDoc, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import type { PageDoc } from "@repo/cms-core/types";
import { validatePageDoc } from "@repo/cms-core/validate";
import { agentThreads, pages } from "@repo/db";
import { createD1AgentStore } from "@repo/db/agent-store";
import { createTestDb } from "@repo/db/test-utils";
import { createMemoryAgentStore } from "@repo/services/agent/memory-store";
import type { ChangesetRow } from "@repo/services/agent/store-port";
import type { ToolDeps } from "@repo/services/agent/tools";
import {
  checkSlugAvailable,
  createPage,
  getPage,
  listPages,
  type ServiceDeps,
} from "@repo/services/cms/pages-service";
import type { ApiScope } from "@repo/services/mcp/scopes";
import { createMemoryMediaRepo } from "@repo/services/testing/media-memory-repo";
import { createMemoryRepo } from "@repo/services/testing/memory-repo";
import { createSiteMemoryRepo } from "@repo/services/testing/site-memory-repo";

import { callMcpTool, type McpDeps } from "./tools";

const T0 = Date.parse("2026-10-03T00:00:00Z");

export function docAt(slug: string): PageDoc {
  const doc = sampleDoc();
  return { ...doc, seo: { ...doc.seo, slug } };
}

/** The MCP tools on the in-memory page repo and agent store, with a key of `scope`. */
export function mcpSetup(scope: ApiScope = "full") {
  let clock = T0;
  let n = 0;
  const store = createMemoryAgentStore();
  const kvData = new Map<string, string>();
  const cms: ServiceDeps = {
    repo: createMemoryRepo({
      decideChangeset: (d) =>
        store.decideNow(d.id, d.status, d.decision, d.decidedAt),
    }).repo,
    kv: {
      get: async (k) => kvData.get(k) ?? null,
      put: async (k, v) => void kvData.set(k, v),
      delete: async (k) => void kvData.delete(k),
    },
    validate: validatePageDoc,
    labelFor: (t) => t,
    now: () => (clock += 1000),
    genId: () => `id${++n}`,
    author: "mcp:laptop#cms_dev_Abc12345",
  };
  const tools: ToolDeps = {
    store,
    pageBySlug: (slug) => getPage(cms, { slug }),
    pageById: (id) => getPage(cms, { id }),
    liveDoc: async (page) =>
      page.liveRevId
        ? ((await cms.repo.getRevision(page.liveRevId))?.docJson ?? null)
        : null,
    listPages: () => listPages(cms),
    draftPages: async () => [],
    config: TEST_CONFIG,
    // propose_seo trims titles against the site's title template (agent/seo-title.ts).
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
    renderPreview: async () => new Uint8Array([0xff, 0xd8]),
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
  const calls: {
    tool: string;
    target: string | null;
    ok: boolean;
    errorCode: string | null;
  }[] = [];
  const deps: McpDeps = {
    key: {
      id: "key1",
      kind: "api-key",
      name: "laptop",
      prefix: "cms_dev_Abc12345",
      scope,
    },
    origin: "https://test.local",
    tools,
    store,
    cms,
    site: {
      repo: createSiteMemoryRepo().repo,
      kv: cms.kv,
      config: TEST_CONFIG,
      author: "mcp:laptop#cms_dev_Abc12345",
    },
    media: {
      repo: createMemoryMediaRepo().repo,
      blobs: { put: async () => undefined },
    },
    log: async (c) => void calls.push(c),
    now: () => clock,
  };
  const call = async (name: string, input: unknown = {}) => {
    const res = await callMcpTool(deps, name, input);
    const first = res.content[0];
    return {
      isError: !!res.isError,
      body: first?.type === "text" ? JSON.parse(first.text) : null,
      content: res.content,
    };
  };
  return { deps, cms, store, tools, calls, call, kv: kvData };
}

describe("MCP tool dispatch", () => {
  it("runs a read tool and logs the call", async () => {
    const { cms, call, calls } = mcpSetup("read");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await call("list_pages");
    expect(res.isError).toBe(false);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: page.id,
        slug: "services/a",
        status: "draft",
        draftVersion: 0,
      }),
    ]);
    expect(calls).toEqual([
      { tool: "list_pages", target: null, ok: true, errorCode: null },
    ]);
  });

  it("returns INTERNAL without the detail for an unexpected error, and logs it", async () => {
    const { cms, call, calls } = mcpSetup("read");
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    cms.repo.listPages = async () => {
      throw new Error("D1_ERROR: no such table: secret_table");
    };
    const res = await call("list_pages");
    expect(res).toMatchObject({
      isError: true,
      body: { ok: false, code: "INTERNAL", message: "Internal error" },
    });
    expect(JSON.stringify(res.content)).not.toContain("secret_table");
    expect(String(log.mock.calls[0]?.[1])).toContain("secret_table");
    expect(calls.at(-1)).toMatchObject({ ok: false, errorCode: "INTERNAL" });
    log.mockRestore();
  });

  it("adds the page id to get_page", async () => {
    const { cms, call } = mcpSetup("read");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await call("get_page", { slug: "services/a", mode: "outline" });
    expect(res.body).toMatchObject({
      id: page.id,
      slug: "services/a",
      draftVersion: 0,
    });
  });

  it("refuses unknown tools and bad input as tool errors, and logs them", async () => {
    const { call, calls } = mcpSetup("read");
    expect(await call("nope")).toMatchObject({
      isError: true,
      body: { code: "NOT_FOUND" },
    });
    expect(await call("get_page", { slug: 3 })).toMatchObject({
      isError: true,
      body: { code: "INVALID_INPUT" },
    });
    expect(await call("list_revisions", { id: "x", slug: "y" })).toMatchObject({
      isError: true,
      body: {
        code: "INVALID_INPUT",
        message: expect.stringContaining("exactly one"),
      },
    });
    expect(calls.map((c) => [c.tool, c.ok, c.errorCode])).toEqual([
      ["nope", false, "NOT_FOUND"],
      ["get_page", false, "INVALID_INPUT"],
      ["list_revisions", false, "INVALID_INPUT"],
    ]);
  });

  it("maps an agent tool's error to its code", async () => {
    const { call, calls } = mcpSetup("read");
    expect(
      await call("get_page", { slug: "missing", mode: "outline" })
    ).toMatchObject({ isError: true });
    expect(calls[0]).toMatchObject({
      ok: false,
      errorCode: "NOT_FOUND",
      target: "missing",
    });
  });
});

describe("without the agent's tools", () => {
  it("answers the tools that run through the agent with NOT_AVAILABLE, and the rest as usual", async () => {
    const s = mcpSetup("write");
    s.deps.tools = null;
    await createPage(s.cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    expect(
      await s.call("get_page", { slug: "services/a", mode: "outline" })
    ).toMatchObject({ isError: true, body: { code: "NOT_AVAILABLE" } });
    expect(
      await s.call("propose_ops", {
        slug: "services/a",
        summary: "x",
        ops: [{ op: "remove", key: "faq1" }],
      })
    ).toMatchObject({ isError: true, body: { code: "NOT_AVAILABLE" } });
    expect(await s.call("list_pages")).toMatchObject({ isError: false });
    expect(s.calls.at(-2)).toMatchObject({
      tool: "propose_ops",
      ok: false,
      errorCode: "NOT_AVAILABLE",
    });
  });
});

describe("review queue (SQL)", () => {
  const row = (
    id: string,
    threadId: string,
    pageId: string,
    status: ChangesetRow["status"],
    at: number
  ): ChangesetRow => ({
    id,
    threadId,
    pageId,
    kind: "ops",
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

  it("lists every pending changeset newest first, with its source and page, optionally for one page", async () => {
    const { db } = createTestDb();
    await db.insert(pages).values([
      {
        id: "pa",
        kind: "page",
        slug: "services/a",
        title: "A",
        status: "draft",
        draftDoc: sampleDoc(),
        updatedAt: new Date(0),
      },
      {
        id: "pb",
        kind: "page",
        slug: "services/b",
        title: "B",
        status: "published",
        draftDoc: sampleDoc(),
        updatedAt: new Date(0),
      },
    ]);
    const thread = (
      id: string,
      pageId: string,
      scope: "page" | "site" | "item"
    ) => ({
      id,
      pageId,
      title: id,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      scope,
    });
    await db
      .insert(agentThreads)
      .values([
        thread("conv", "pa", "page"),
        thread("run_x~1", "pb", "item"),
        thread("site", "pa", "site"),
      ]);
    const store = createD1AgentStore(db);
    await store.insertChangeset(row("c1", "conv", "pa", "pending", 1));
    await store.insertChangeset(row("c2", "run_x~1", "pb", "pending", 3));
    await store.insertChangeset(row("c3", "site", "pa", "pending", 2));
    await store.insertChangeset(row("c4", "conv", "pa", "accepted", 4));
    await store.insertChangeset(row("c5", "conv", "gone", "pending", 0));

    const all = await store.pendingChangesets();
    expect(all.map((c) => [c.id, c.threadScope, c.page?.slug ?? null])).toEqual(
      [
        ["c2", "item", "services/b"],
        ["c3", "site", "services/a"],
        ["c1", "page", "services/a"],
        ["c5", "page", null],
      ]
    );
    expect(all[0]!.page).toEqual({
      slug: "services/b",
      title: "B",
      status: "published",
    });
    expect((await store.pendingChangesets("pa")).map((c) => c.id)).toEqual([
      "c3",
      "c1",
    ]);
  });

  it("shows in list_review_queue with run or conversation as the source", async () => {
    const { cms, store, call } = mcpSetup("read");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    await store.createThread({
      id: "conv",
      pageId: page.id,
      title: "t",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await store.createThread({
      id: "run_x~1",
      pageId: page.id,
      title: "t",
      author: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      scope: "item",
    });
    await store.insertChangeset(row("c1", "conv", page.id, "pending", 1));
    await store.insertChangeset(row("c2", "run_x~1", page.id, "pending", 2));
    const res = await call("list_review_queue", { slug: "services/a" });
    expect(res.body.pending).toEqual([
      expect.objectContaining({
        id: "c2",
        source: "run",
        runId: "run_x",
        page: { id: page.id },
      }),
      expect.objectContaining({ id: "c1", source: "conversation" }),
    ]);
    const one = await call("get_changeset", { id: "c1" });
    expect(one.body).toMatchObject({
      id: "c1",
      status: "pending",
      source: "conversation",
      page: { id: page.id, draftVersion: 0 },
      ops: [],
      conflicts: [],
    });
  });
});

describe("scope gate", () => {
  it("refuses a tool above the key's scope with a tool error naming the scope, and logs it", async () => {
    const { cms, call, calls } = mcpSetup("read");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await call("update_page", {
      id: page.id,
      draftVersion: 0,
      ops: [{ op: "remove", key: "faq1" }],
    });
    expect(res).toMatchObject({
      isError: true,
      body: {
        code: "SCOPE",
        message: expect.stringContaining('"write" scope'),
      },
    });
    expect((await getPage(cms, { id: page.id }))!.draftVersion).toBe(0);
    expect(calls).toEqual([
      { tool: "update_page", target: page.id, ok: false, errorCode: "SCOPE" },
    ]);
  });

  it("lets a write key edit drafts", async () => {
    const { cms, call } = mcpSetup("write");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    expect(
      await call("update_page", {
        id: page.id,
        draftVersion: 0,
        ops: [{ op: "remove", key: "faq1" }],
      })
    ).toMatchObject({ isError: false });
  });
});

describe("update_page", () => {
  it("applies Markdown ops and setSeo to the draft, with the key as the revision author", async () => {
    const { cms, call } = mcpSetup("write");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await call("update_page", {
      slug: "services/a",
      draftVersion: 0,
      ops: [
        {
          op: "insert",
          at: { after: "hero1" },
          block: {
            _type: "richText",
            props: { body: "## New\n\nSome **bold** text." },
          },
        },
        { op: "update", key: "hero1", props: { heading: "Changed" } },
        { op: "setSeo", seo: { title: "New title" } },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({
      ok: true,
      draftVersion: 1,
      changes: {
        blocks: expect.arrayContaining([
          expect.objectContaining({ status: "added", type: "richText" }),
        ]),
      },
    });
    const after = (await getPage(cms, { id: page.id }))!;
    expect(after.draftDoc!.blocks[0]!.props).toMatchObject({
      heading: "Changed",
    });
    expect(JSON.stringify(after.draftDoc!.blocks[1]!.props)).toContain(
      '"type":"heading"'
    );
    expect(after.draftDoc!.seo.title).toBe("New title");
    // The first edit snapshots the draft before it, by this key.
    expect((await cms.repo.listRevisions(page.id))[0]!.author).toBe(
      "mcp:laptop#cms_dev_Abc12345"
    );
  });

  it("refuses a stale draftVersion with the current one", async () => {
    const { cms, call } = mcpSetup("write");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    await call("update_page", {
      id: page.id,
      draftVersion: 0,
      ops: [{ op: "remove", key: "faq1" }],
    });
    const res = await call("update_page", {
      id: page.id,
      draftVersion: 0,
      ops: [{ op: "remove", key: "grid1" }],
    });
    expect(res).toMatchObject({
      isError: true,
      body: { code: "STALE_DRAFT", details: { current: 1 } },
    });
    expect(
      (await getPage(cms, { id: page.id }))!.draftDoc!.blocks.map((b) => b._key)
    ).toContain("grid1");
  });

  it("reports bad ops with the agent's codes and paths", async () => {
    const { cms, call } = mcpSetup("write");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await call("update_page", {
      id: page.id,
      draftVersion: 0,
      ops: [{ op: "remove", key: "nope" }],
    });
    expect(res).toMatchObject({ isError: true, body: { code: "UNKNOWN_KEY" } });
  });
});

describe("proposals over MCP and the server-side accept", () => {
  async function staged(scope: ApiScope = "write") {
    const s = mcpSetup(scope);
    const page = await createPage(s.cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await s.call("propose_ops", {
      slug: "services/a",
      summary: "New heading",
      ops: [{ op: "update", key: "hero1", props: { heading: "Proposed" } }],
    });
    expect(res.isError).toBe(false);
    return { ...s, page, csId: res.body.changesetId as string };
  }

  it("stages the proposal in this key's conversation for the page, which shows in the queue", async () => {
    const { store, page, csId, call } = await staged();
    const thread = await store.getThread(`mcp_key1_${page.id}`);
    expect(thread).toMatchObject({
      pageId: page.id,
      author: "mcp:laptop#cms_dev_Abc12345",
      scope: "page",
      title: "Claude Code (laptop)",
    });
    expect((await store.getChangeset(csId))!.threadId).toBe(thread!.id);
    expect((await call("list_review_queue")).body.pending).toEqual([
      expect.objectContaining({ id: csId, source: "conversation" }),
    ]);
    // A second proposal on the same page reuses the conversation.
    await call("propose_ops", {
      slug: "services/a",
      summary: "Again",
      ops: [{ op: "remove", key: "faq1" }],
    });
    expect(store.rows.threads).toHaveLength(1);
  });

  it("accepts a conversation proposal in one commit with its decision, tagged with the conversation", async () => {
    const { cms, store, page, csId, call } = await staged();
    const res = await call("accept_changeset", { id: csId });
    expect(res).toMatchObject({
      isError: false,
      body: { ok: true, draftVersion: 1 },
    });
    const after = (await getPage(cms, { id: page.id }))!;
    expect(after.draftDoc!.blocks[0]!.props).toMatchObject({
      heading: "Proposed",
    });
    const [rev] = await cms.repo.listRevisions(page.id);
    expect(rev).toMatchObject({
      kind: "agent",
      author: "mcp:laptop#cms_dev_Abc12345",
      agentRunId: `mcp_key1_${page.id}`,
    });
    expect(await store.getChangeset(csId)).toMatchObject({
      status: "accepted",
      decision: { accepted: ["hero1"], rejected: [], revId: rev!.id },
    });
    expect(await call("accept_changeset", { id: csId })).toMatchObject({
      isError: true,
      body: { code: "LIVE_CHANGED" },
    });
  });

  it("refuses when the proposal's block changed since, unless the reviewed draftVersion and the block are confirmed", async () => {
    const { cms, page, csId, call } = await staged();
    await call("update_page", {
      id: page.id,
      draftVersion: 0,
      ops: [
        { op: "update", key: "hero1", props: { lead: "Edited meanwhile." } },
      ],
    });
    expect(await call("accept_changeset", { id: csId })).toMatchObject({
      isError: true,
      body: {
        code: "LIVE_CHANGED",
        details: { conflicts: [{ group: "hero1", reason: "changed" }] },
      },
    });
    expect(
      await call("accept_changeset", {
        id: csId,
        draftVersion: 0,
        confirmConflicts: ["hero1"],
      })
    ).toMatchObject({
      isError: true,
      body: { code: "STALE_DRAFT", details: { current: 1 } },
    });
    expect(
      await call("accept_changeset", { id: csId, draftVersion: 1 })
    ).toMatchObject({ isError: true, body: { code: "LIVE_CHANGED" } });
    expect(
      await call("accept_changeset", {
        id: csId,
        draftVersion: 1,
        confirmConflicts: ["hero1"],
      })
    ).toMatchObject({ isError: false });
    expect(
      (await getPage(cms, { id: page.id }))!.draftDoc!.blocks[0]!.props
    ).toMatchObject({ heading: "Proposed", lead: "Edited meanwhile." });
  });

  it("needs a variant for an SEO proposal", async () => {
    const s = mcpSetup("write");
    const page = await createPage(s.cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const res = await s.call("propose_seo", {
      slug: "services/a",
      seo: { focusKeyphrase: "ai audit" },
      variants: [
        { title: "AI audit for SMEs", description: "One." },
        { title: "AI audits that pay", description: "Two." },
      ],
    });
    expect(res.isError).toBe(false);
    const id = res.body.changesetId;
    expect(await s.call("accept_changeset", { id })).toMatchObject({
      isError: true,
      body: { code: "INVALID_OPS", message: expect.stringContaining("title") },
    });
    expect(await s.call("accept_changeset", { id, variant: 1 })).toMatchObject({
      isError: false,
    });
    expect(
      (await getPage(s.cms, { id: page.id }))!.draftDoc!.seo
    ).toMatchObject({
      title: "AI audits that pay",
      focusKeyphrase: "ai audit",
    });
  });

  it("rejects a conversation proposal without touching the page", async () => {
    const { cms, store, page, csId, call } = await staged();
    expect(await call("reject_changeset", { id: csId })).toMatchObject({
      isError: false,
    });
    expect(await store.getChangeset(csId)).toMatchObject({
      status: "rejected",
      decision: { accepted: [], rejected: ["hero1"] },
    });
    expect((await getPage(cms, { id: page.id }))!.draftVersion).toBe(0);
    expect(await call("reject_changeset", { id: csId })).toMatchObject({
      isError: true,
      body: { code: "LIVE_CHANGED" },
    });
  });
});

describe("media and site", () => {
  const PNG = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    ),
    (c) => c.charCodeAt(0)
  );

  it("uploads base64 and fetched images, only images from http(s), at most 10 MB", async () => {
    const s = mcpSetup("write");
    const up = await s.call("upload_media", {
      base64: btoa(String.fromCharCode(...PNG)),
      alt: "A dot",
    });
    expect(up).toMatchObject({
      isError: false,
      body: { created: true, mime: "image/png", width: 1, alt: "A dot" },
    });
    const served = (body: BodyInit, type: string) => async () =>
      new Response(body, { headers: { "Content-Type": type } });
    s.deps.fetch = served(PNG, "image/png") as unknown as typeof fetch;
    expect(
      await s.call("upload_media", { url: "https://img.example/a.png" })
    ).toMatchObject({
      isError: false,
      body: { created: false, mediaId: up.body.mediaId },
    });
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    s.deps.fetch = served("<html>", "text/html") as unknown as typeof fetch;
    expect(
      await s.call("upload_media", { url: "https://img.example/a" })
    ).toMatchObject({
      isError: true,
      body: { code: "FETCH_FAILED", message: "Fetching the image failed." },
    });
    expect(
      await s.call("upload_media", { url: "file:///etc/passwd" })
    ).toMatchObject({ isError: true, body: { code: "BLOCKED_URL" } });
    log.mockRestore();
    s.deps.fetch = served(
      new Uint8Array(10 * 1024 * 1024 + 1),
      "image/png"
    ) as unknown as typeof fetch;
    expect(
      await s.call("upload_media", { url: "https://img.example/big.png" })
    ).toMatchObject({ isError: true, body: { code: "TOO_LARGE" } });
    expect(
      await s.call("update_media", { id: up.body.mediaId, alt: "A red dot" })
    ).toMatchObject({ body: { alt: "A red dot" } });
  });

  it("fetches only public https hosts, re-checking every redirect, with a timeout", async () => {
    const s = mcpSetup("write");
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    let signal: AbortSignal | null | undefined;
    const respond =
      (route: (url: string) => Response) =>
      async (url: string, init?: RequestInit) => {
        seen.push(url);
        signal = init?.signal;
        expect(init?.redirect).toBe("manual");
        return route(url);
      };
    const redirect = (to: string) =>
      new Response(null, { status: 302, headers: { Location: to } });
    const png = () =>
      new Response(PNG, { headers: { "Content-Type": "image/png" } });
    const upload = async (url: string) =>
      (await s.call("upload_media", { url })).body.code;

    s.deps.fetch = respond(png) as unknown as typeof fetch;
    for (const url of [
      "http://img.example/a.png",
      "https://127.0.0.1/a.png",
      "https://2130706433/a.png",
      "https://0x7f.1/a.png",
      "https://[::1]/a.png",
      "https://[::ffff:169.254.169.254]/a.png",
      "https://localhost/a.png",
      "https://LOCALHOST./a.png",
      "https://api.localhost/a.png",
      "https://printer.local/a.png",
      "https://metadata.google.internal/a.png",
      "https://intranet/a.png",
    ]) {
      expect(await upload(url)).toBe("BLOCKED_URL");
    }
    expect(seen).toEqual([]);

    // A redirect to an internal host is refused before it's fetched.
    s.deps.fetch = respond((u) =>
      u.startsWith("https://img.example/")
        ? redirect("http://localhost/x")
        : png()
    ) as unknown as typeof fetch;
    expect(await upload("https://img.example/a.png")).toBe("BLOCKED_URL");
    expect(seen).toEqual(["https://img.example/a.png"]);

    // Relative redirects are followed, up to 3 of them.
    seen.length = 0;
    s.deps.fetch = respond((u) => {
      const n = Number(new URL(u).searchParams.get("n") ?? 0);
      return n < 3 ? redirect(`/a.png?n=${n + 1}`) : png();
    }) as unknown as typeof fetch;
    expect(
      await s.call("upload_media", { url: "https://img.example/a.png" })
    ).toMatchObject({ isError: false, body: { created: true } });
    expect(seen).toHaveLength(4);
    expect(signal).toBeInstanceOf(AbortSignal);

    seen.length = 0;
    s.deps.fetch = respond(() =>
      redirect("https://img.example/again")
    ) as unknown as typeof fetch;
    expect(await upload("https://img.example/a.png")).toBe("FETCH_FAILED");
    expect(seen).toHaveLength(4);

    s.deps.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await upload("https://img.example/slow.png")).toBe("FETCH_FAILED");

    s.deps.fetch = respond(
      () => new Response("nope", { status: 404 })
    ) as unknown as typeof fetch;
    expect(
      await s.call("upload_media", {
        url: "https://img.example/a.png?token=s3cret",
      })
    ).toMatchObject({
      body: { code: "FETCH_FAILED", message: "Fetching the image failed." },
    });
    // The log names the host, never the path or query.
    expect(log.mock.calls.flat().join(" ")).not.toContain("s3cret");
    expect(log.mock.calls.flat().join(" ")).toContain("img.example");
    log.mockRestore();
  });

  it("fetches http URLs too when the site origin is http (local dev)", async () => {
    const s = mcpSetup("write");
    s.deps.fetch = (async () =>
      new Response(PNG, {
        headers: { "Content-Type": "image/png" },
      })) as unknown as typeof fetch;
    s.deps.origin = "http://localhost:3000";
    expect(
      await s.call("upload_media", { url: "http://img.example/a.png" })
    ).toMatchObject({ isError: false, body: { created: true } });
  });

  it("saves the site draft with its draftVersion", async () => {
    const s = mcpSetup("write");
    const site = (await s.call("get_site")).body;
    expect(
      await s.call("save_site_draft", { draftVersion: 0, doc: site.draft })
    ).toMatchObject({ isError: false, body: { draftVersion: 1 } });
    expect(
      await s.call("save_site_draft", { draftVersion: 0, doc: site.draft })
    ).toMatchObject({ isError: true, body: { code: "STALE_DRAFT" } });
  });
});

describe("publish tools", () => {
  it("need the full scope", async () => {
    const { cms, call } = mcpSetup("write");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    for (const [name, input] of [
      ["publish_page", { id: page.id, draftVersion: 0 }],
      ["archive_page", { id: page.id }],
      ["unarchive_page", { id: page.id }],
      ["unpublish_page", { id: page.id }],
      ["rollback_live", { id: page.id, revId: "r" }],
      ["publish_site", { draftVersion: 0 }],
    ] as const) {
      expect(await call(name, input)).toMatchObject({
        isError: true,
        body: {
          code: "SCOPE",
          message: expect.stringContaining('"full" scope'),
        },
      });
    }
    expect((await getPage(cms, { id: page.id }))!.status).toBe("draft");
  });

  it("publish, archive (gone from the site), unarchive (a draft again), publish again", async () => {
    const { cms, call, kv } = mcpSetup("full");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    expect(
      await call("publish_page", { id: page.id, draftVersion: 1 })
    ).toMatchObject({ isError: true, body: { code: "STALE_DRAFT" } });
    const pub = await call("publish_page", {
      slug: "services/a",
      draftVersion: 0,
      expectedLiveRevId: null,
    });
    expect(pub).toMatchObject({
      isError: false,
      body: { live: true, url: "https://test.local/services/a" },
    });
    expect(JSON.parse(kv.get("page:services/a")!).revId).toBe(pub.body.revId);
    expect((await cms.repo.getRevision(pub.body.revId))!.author).toBe(
      "mcp:laptop#cms_dev_Abc12345"
    );

    expect(await call("archive_page", { slug: "services/a" })).toMatchObject({
      isError: false,
      body: { status: "archived" },
    });
    expect(kv.has("page:services/a")).toBe(false);
    expect(
      await call("get_page", { slug: "services/a", mode: "outline" })
    ).toMatchObject({ isError: true });
    expect((await call("list_pages", { includeArchived: true })).body).toEqual([
      expect.objectContaining({ id: page.id, status: "archived" }),
    ]);

    expect(await call("unarchive_page", { id: page.id })).toMatchObject({
      isError: false,
      body: { status: "draft", slug: "services/a" },
    });
    expect(await call("unarchive_page", { id: page.id })).toMatchObject({
      isError: true,
      body: { code: "NOT_ARCHIVED" },
    });
    expect(
      await call("publish_page", { id: page.id, draftVersion: 0 })
    ).toMatchObject({ isError: false, body: { live: true } });
  });

  it("rolls the live page back and unpublishes it", async () => {
    const { cms, call, kv } = mcpSetup("full");
    const page = await createPage(cms, {
      kind: "page",
      slug: "services/a",
      title: "A",
      doc: docAt("services/a"),
    });
    const first = (await call("publish_page", { id: page.id, draftVersion: 0 }))
      .body.revId;
    await call("update_page", {
      id: page.id,
      draftVersion: 0,
      ops: [{ op: "update", key: "hero1", props: { heading: "Second" } }],
    });
    await call("publish_page", { id: page.id, draftVersion: 1 });
    expect(
      JSON.parse(kv.get("page:services/a")!).doc.blocks[0].props.heading
    ).toBe("Second");
    expect(
      await call("rollback_live", { id: page.id, revId: first })
    ).toMatchObject({ isError: false, body: { live: true } });
    expect(
      JSON.parse(kv.get("page:services/a")!).doc.blocks[0].props.heading
    ).toBe("Hello CMS");
    expect(await call("unpublish_page", { id: page.id })).toMatchObject({
      isError: false,
      body: { status: "draft" },
    });
    expect(kv.has("page:services/a")).toBe(false);
  });
});
