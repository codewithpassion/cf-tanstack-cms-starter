// biome-ignore-all lint/style/noNonNullAssertion: test-only; values are checked just above.
import { describe, expect, it } from "bun:test";
import { pagesRouter } from "./pages.ts";
import { contextFor, createTestCms } from "./test-context.ts";

function setup() {
  const { services, kv } = createTestCms();
  return {
    kv,
    caller: pagesRouter.createCaller(contextFor("admin", services)),
  };
}

describe("pages router: admin gate", () => {
  it("answers an anonymous caller UNAUTHORIZED", async () => {
    const caller = pagesRouter.createCaller(contextFor("anonymous"));
    await expect(caller.requireAdmin()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.listPages()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("answers a signed-in non-admin FORBIDDEN", async () => {
    const caller = pagesRouter.createCaller(contextFor("user"));
    await expect(caller.requireAdmin()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects a non-admin before parsing the input", async () => {
    const caller = pagesRouter.createCaller(contextFor("user"));
    // Invalid input: were it parsed first, this would be BAD_REQUEST.
    await expect(
      caller.createPage({ slug: 42, title: null } as unknown as {
        slug: string;
        title: string;
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets an admin through", async () => {
    const { caller } = setup();
    expect(await caller.requireAdmin()).toEqual({ ok: true });
  });
});

describe("pages router", () => {
  it("creates a page and lists it", async () => {
    const { caller } = setup();
    const made = await caller.createPage({ slug: "about", title: "  About  " });
    expect(made.ok).toBe(true);
    const list = await caller.listPages();
    expect(list.ok && list.pages).toEqual([
      {
        id: made.ok ? made.id : "",
        kind: "page",
        slug: "about",
        title: "About",
        status: "draft",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("returns a taken slug as a result, and a bad title as BAD_REQUEST with the source's text", async () => {
    const { caller } = setup();
    await caller.createPage({ slug: "about", title: "About" });
    expect(await caller.checkSlug({ slug: "about" })).toMatchObject({
      ok: false,
      code: "SLUG_TAKEN",
    });
    expect(
      await caller.createPage({ slug: "about", title: "Again" })
    ).toMatchObject({ ok: false, code: "SLUG_TAKEN" });
    await expect(
      caller.createPage({ slug: "long", title: "x".repeat(201) })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: {
        issues: [{ message: 'Expected "title" to be at most 200 characters' }],
      },
    });
  });

  it("saves draft ops, publishes to KV and reports the path", async () => {
    const { caller, kv } = setup();
    const made = await caller.createPage({ slug: "about", title: "About" });
    const id = made.ok ? made.id : "";
    const editor = await caller.getEditorPage({ id });
    expect(editor).toMatchObject({
      ok: true,
      page: { id, slug: "about", liveRevId: null },
      draftVersion: 0,
      hasUnpublishedChanges: false,
    });
    const doc = JSON.parse(editor.ok ? editor.draftDocJson : "{}");

    const saved = await caller.saveDraftOps({
      pageId: id,
      draftVersion: 0,
      batchId: "b1",
      ops: [{ op: "setSeo", seo: { title: "About us" } }],
    });
    expect(saved).toMatchObject({ ok: true, draftVersion: 1 });
    expect(JSON.parse(saved.ok ? saved.docJson : "{}").seo.title).toBe(
      "About us"
    );
    expect(doc.seo.title).not.toBe("About us");

    expect(
      await caller.saveDraftOps({ pageId: id, draftVersion: 0, ops: [] })
    ).toMatchObject({ ok: false, code: "STALE_DRAFT" });

    const published = await caller.publishPage({
      pageId: id,
      draftVersion: 1,
      expectedLiveRevId: null,
    });
    expect(published).toEqual({
      ok: true,
      live: true,
      revId: expect.any(String),
      path: "/about",
    });
    expect(JSON.parse((await kv.get("page:about"))!).doc.seo.title).toBe(
      "About us"
    );

    const unpublished = await caller.unpublishPage({ pageId: id });
    expect(unpublished).toEqual({ ok: true, synced: true });
    expect(await kv.get("page:about")).toBeNull();
  });

  it("returns bad ops as INVALID_OPS", async () => {
    const { caller } = setup();
    const made = await caller.createPage({ slug: "about", title: "About" });
    expect(
      await caller.saveDraftOps({
        pageId: made.ok ? made.id : "",
        draftVersion: 0,
        ops: "nope",
      })
    ).toMatchObject({ ok: false, code: "INVALID_OPS" });
  });

  it("names a version and checks the name and cursor before the service", async () => {
    const { caller } = setup();
    const made = await caller.createPage({ slug: "about", title: "About" });
    const pageId = made.ok ? made.id : "";
    expect(
      await caller.saveNamedVersion({ pageId, label: "First", draftVersion: 0 })
    ).toMatchObject({ ok: true, revId: expect.any(String) });
    const history = await caller.listRevisions({ pageId });
    expect(history.ok && history.revisions[0]).toMatchObject({
      kind: "named",
      label: "First",
      byYou: true,
    });
    await expect(
      caller.saveNamedVersion({ pageId, label: "   " })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { issues: [{ message: "A version name needs 1–80 characters" }] },
    });
    await expect(
      caller.listRevisions({ pageId, cursor: "abc" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: {
        issues: [
          { message: 'Expected "cursor" to be a cursor from a previous page' },
        ],
      },
    });
  });
});
