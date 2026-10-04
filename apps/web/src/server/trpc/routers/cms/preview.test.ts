import { describe, expect, it } from "bun:test";
import { pagesRouter } from "./pages.ts";
import { previewRouter } from "./preview.ts";
import { publicRouter } from "./public.ts";
import { contextFor, createTestCms } from "./test-context.ts";

function setup() {
  const { services, kv } = createTestCms();
  const ctx = contextFor("admin", services);
  return {
    kv,
    pages: pagesRouter.createCaller(ctx),
    preview: previewRouter.createCaller(ctx),
    // The public router needs no admin: an anonymous caller over the same services.
    public: publicRouter.createCaller(contextFor("anonymous", services)),
  };
}

async function publishedAbout(pages: ReturnType<typeof setup>["pages"]) {
  const made = await pages.createPage({ slug: "about", title: "About" });
  const id = made.ok ? made.id : "";
  await pages.publishPage({ pageId: id, draftVersion: 0 });
  await pages.saveDraftOps({
    pageId: id,
    draftVersion: 0,
    ops: [{ op: "setSeo", seo: { title: "Draft title" } }],
  });
  return id;
}

describe("preview router", () => {
  it("is admin only", async () => {
    await expect(
      previewRouter.createCaller(contextFor("anonymous")).getLiveDoc({
        pageId: "x",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns the live doc, and NOT_FOUND for an unknown page", async () => {
    const { pages, preview } = setup();
    const id = await publishedAbout(pages);
    const live = await preview.getLiveDoc({ pageId: id });
    expect(live).toMatchObject({
      ok: true,
      live: { revId: expect.any(String) },
    });
    const doc = JSON.parse(live.ok && live.live ? live.live.docJson : "{}");
    expect(doc.seo.title).not.toBe("Draft title");
    expect(await preview.getLiveDoc({ pageId: "nope" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("signs a link the public loader turns into the draft", async () => {
    const { pages, preview, public: pub } = setup();
    const id = await publishedAbout(pages);
    const link = await preview.createPreviewLink({ pageId: id });
    expect(link).toMatchObject({ ok: true, expiresAt: expect.any(String) });
    const url = new URL(link.ok ? link.url : "/", "https://example.com");
    expect(url.pathname).toBe("/about");
    const token = url.searchParams.get("_preview") ?? "";

    const draft = await pub.loadCmsPage({ path: "/about", preview: token });
    expect(draft).toMatchObject({ preview: true });
    const live = await pub.loadCmsPage({ path: "/about" });
    expect("preview" in live).toBe(false);
  });
});
