import { describe, expect, it } from "bun:test";

import { ChangesetDecided, createD1Repo, createPageQueries } from "./pages.ts";
import {
  agentChangesets,
  agentThreads,
  type PageRow,
  type RevisionRow,
} from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

// Documents here only need the fields the SQL reads (seo, post); cast past the full PageDoc shape.
const doc = (title: string) => ({ seo: { title, slug: title } }) as never;
const at = (ms: number) => new Date(ms);

const page = (over: Partial<PageRow> = {}): PageRow => ({
  id: "p1",
  kind: "page",
  slug: "about",
  title: "About",
  status: "draft",
  draftDoc: doc("v0"),
  draftVersion: 0,
  draftBaseRevId: null,
  liveRevId: null,
  lastBatchId: null,
  updatedAt: at(1),
  ...over,
});

const rev = (id: string, over: Partial<RevisionRow> = {}): RevisionRow => ({
  id,
  pageId: "p1",
  parentRevId: null,
  docJson: doc(id),
  kind: "autosnapshot",
  label: null,
  summary: null,
  author: null,
  agentRunId: null,
  createdAt: at(10),
  ...over,
});

async function setup() {
  const { db } = createTestDb();
  const repo = createD1Repo(db);
  await repo.insertPage(page());
  return { db, repo };
}

describe("findPage and saveDraft", () => {
  it("finds by id and by slug, but a slug lookup skips archived pages", async () => {
    const { repo } = await setup();
    expect((await repo.findPage({ id: "p1" }))?.slug).toBe("about");
    expect((await repo.findPage({ slug: "about" }))?.id).toBe("p1");
    await repo.commit("p1", [], { status: "archived" });
    expect(await repo.findPage({ slug: "about" })).toBeNull();
    expect((await repo.findPage({ id: "p1" }))?.status).toBe("archived");
  });

  it("saves a draft only from the version it was based on, and records the batch id", async () => {
    const { repo } = await setup();
    expect(await repo.saveDraft("p1", 0, doc("v1") as never, at(2), "b1")).toBe(
      true
    );
    // A second save from version 0 is stale.
    expect(await repo.saveDraft("p1", 0, doc("v2") as never, at(3))).toBe(
      false
    );
    const row = await repo.findPage({ id: "p1" });
    expect(row).toMatchObject({
      draftVersion: 1,
      lastBatchId: "b1",
      draftDoc: doc("v1"),
    });
  });
});

describe("commit", () => {
  it("appends revisions and patches the page atomically when the draft version matches", async () => {
    const { repo } = await setup();
    const ok = await repo.commit("p1", [rev("r1", { kind: "published" })], {
      status: "published",
      liveRevId: "r1",
      bumpDraftVersion: true,
      ifDraftVersion: 0,
    });
    expect(ok).toBe(true);
    expect(await repo.findPage({ id: "p1" })).toMatchObject({
      status: "published",
      liveRevId: "r1",
      draftVersion: 1,
    });
    expect((await repo.getRevision("r1"))?.kind).toBe("published");
  });

  it("writes nothing and returns false when the draft version moved (compare-and-set guard)", async () => {
    const { repo } = await setup();
    await repo.saveDraft("p1", 0, doc("v1") as never, at(2));
    const ok = await repo.commit("p1", [rev("r1")], {
      status: "published",
      ifDraftVersion: 0,
    });
    expect(ok).toBe(false);
    expect(await repo.getRevision("r1")).toBeNull();
    expect((await repo.findPage({ id: "p1" }))?.status).toBe("draft");
  });

  it("rethrows a failure that is not a stale version, rolling the batch back", async () => {
    const { repo } = await setup();
    await repo.commit("p1", [rev("r1")]);
    // Duplicate revision id: the guard passes, the insert fails, the patch is rolled back.
    await expect(
      repo.commit("p1", [rev("r1")], {
        status: "published",
        ifDraftVersion: 0,
      })
    ).rejects.toThrow();
    expect((await repo.findPage({ id: "p1" }))?.status).toBe("draft");
  });

  it("decides a proposal in the same commit, or throws ChangesetDecided having written nothing", async () => {
    const { db, repo } = await setup();
    await db.insert(agentThreads).values({
      id: "t1",
      pageId: "p1",
      title: "t",
      createdAt: at(1),
      updatedAt: at(1),
    });
    await db.insert(agentChangesets).values({
      id: "c1",
      threadId: "t1",
      pageId: "p1",
      kind: "ops",
      summary: "s",
      status: "pending",
      payload: { ops: [] },
      baseDoc: doc("base"),
      proposedDoc: doc("proposed"),
      createdAt: at(1),
    });
    const decide = {
      id: "c1",
      status: "accepted" as const,
      decision: { by: "me" },
      decidedAt: at(5),
    };
    expect(
      await repo.commit(
        "p1",
        [rev("r1", { kind: "agent" })],
        { ifDraftVersion: 0, bumpDraftVersion: true },
        decide
      )
    ).toBe(true);
    const [cs] = await db.select().from(agentChangesets);
    expect(cs).toMatchObject({ status: "accepted", decision: { by: "me" } });

    await expect(
      repo.commit(
        "p1",
        [rev("r2", { kind: "agent" })],
        { ifDraftVersion: 1, bumpDraftVersion: true },
        decide
      )
    ).rejects.toBeInstanceOf(ChangesetDecided);
    expect(await repo.getRevision("r2")).toBeNull();
  });
});

describe("revisions", () => {
  it("lists newest first with display labels and pins, and keeps batch insertion order", async () => {
    const { repo } = await setup();
    await repo.commit("p1", [
      rev("r1", { label: "first" }),
      rev("r2", { label: "second" }),
    ]);
    await repo.commit("p1", [rev("r3", { createdAt: at(20) })]);
    expect((await repo.listRevisions("p1")).map((r) => r.id)).toEqual([
      "r3",
      "r2",
      "r1",
    ]);
    expect((await repo.latestRevision("p1"))?.id).toBe("r3");

    await repo.labelRevision("r1", { label: "Renamed", pinned: true }, at(30));
    await repo.labelRevision("r1", { pinned: false }, at(31));
    expect(await repo.revisionLabel("r1")).toBe("Renamed");
    expect(await repo.revisionLabel("r2")).toBe("second");
    const page2 = await repo.listRevisionPage("p1", { limit: 2, offset: 1 });
    expect(page2.map((r) => [r.id, r.label, r.pinned])).toEqual([
      ["r2", "second", false],
      ["r1", "Renamed", false],
    ]);
    await repo.labelRevision("r2", { pinned: true }, at(32));
    expect((await repo.pinnedRevisions("p1")).map((r) => r.id)).toEqual(["r2"]);
  });

  it("lists a run's agent revisions oldest first and the published slugs of a page", async () => {
    const { repo } = await setup();
    await repo.commit("p1", [
      rev("r1", { kind: "agent", agentRunId: "run1", createdAt: at(1) }),
      rev("r2", { kind: "agent", agentRunId: "run1", createdAt: at(2) }),
      rev("r3", { kind: "published", docJson: doc("a-slug") }),
      rev("r4", { kind: "published", docJson: doc("b-slug") }),
    ]);
    expect((await repo.runRevisions("run1")).map((r) => r.id)).toEqual([
      "r1",
      "r2",
    ]);
    expect((await repo.publishedSlugs("p1")).sort()).toEqual([
      "a-slug",
      "b-slug",
    ]);
  });

  it("lists live pages and posts with their live revision's document, posts newest first", async () => {
    const { repo } = await setup();
    const post = (id: string, publishedAt: string) => ({
      page: page({
        id,
        kind: "post",
        slug: `blog/${id}`,
        title: id,
        status: "published",
        liveRevId: `${id}-r`,
        draftDoc: null,
      }),
      revision: rev(`${id}-r`, {
        pageId: id,
        kind: "published",
        docJson: { post: { publishedAt } } as never,
      }),
    });
    // Sequential: each page is inserted before the revision that points at it.
    await repo.insertPage(post("x", "2026-01-01").page);
    await repo.insertPage(post("y", "2026-03-01").page);
    await repo.commit("x", [post("x", "2026-01-01").revision]);
    await repo.commit("y", [post("y", "2026-03-01").revision]);
    expect((await repo.livePosts()).map((p) => p.page.id)).toEqual(["y", "x"]);
    expect((await repo.livePages()).map((p) => p.page.id).sort()).toEqual([
      "x",
      "y",
    ]);
  });
});

describe("createPageQueries", () => {
  it("lists posts with live-or-draft fields and flags unpublished edits", async () => {
    const { db, repo } = await setup();
    const q = createPageQueries(db);
    await repo.insertPage(
      page({
        id: "post1",
        kind: "post",
        slug: "blog/hi",
        title: "Row title",
        status: "published",
        liveRevId: "post1-r",
        draftDoc: { post: { title: "Edited" } } as never,
      })
    );
    await repo.commit("post1", [
      rev("post1-r", {
        pageId: "post1",
        kind: "published",
        docJson: { post: { title: "Live", category: "News" } } as never,
      }),
    ]);
    const posts = await q.listPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: "post1",
      title: "Live",
      category: "News",
      rowTitle: "Row title",
      draftChanges: true,
    });
  });

  it("finds slug owners by current slug or draft slug, skipping archived pages", async () => {
    const { db, repo } = await setup();
    const q = createPageQueries(db);
    expect((await q.slugOwners("about")).map((r) => r.id)).toEqual(["p1"]);
    // The draft's seo.slug counts too.
    expect((await q.slugOwners("v0")).map((r) => r.id)).toEqual(["p1"]);
    await repo.commit("p1", [], { status: "archived" });
    expect(await q.slugOwners("about")).toEqual([]);
  });

  it("returns draft SEO summaries and draft documents of non-archived pages", async () => {
    const { db, repo } = await setup();
    const q = createPageQueries(db);
    await repo.insertPage(
      page({
        id: "p2",
        slug: "contact",
        draftDoc: {
          seo: {
            slug: "contact",
            title: "Contact",
            titleExact: true,
            social: { image: { mediaId: "m1" } },
          },
        } as never,
      })
    );
    const seo = await q.draftSeoSummaries();
    expect(seo.find((s) => s.id === "p2")).toMatchObject({
      title: "Contact",
      titleExact: true,
      description: "",
      shareImageId: "m1",
    });
    expect((await q.draftPages()).map((p) => p.id).sort()).toEqual([
      "p1",
      "p2",
    ]);
    expect(await q.pageBrief("p2")).toMatchObject({ slug: "contact" });
    expect(await q.pageBrief("nope")).toBeNull();
  });
});
