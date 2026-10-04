import { describe, expect, it } from "bun:test";
import { pagesRouter } from "./pages.ts";
import { postsRouter } from "./posts.ts";
import { publicRouter } from "./public.ts";
import { siteRouter } from "./site.ts";
import { contextFor, createTestCms } from "./test-context.ts";

function setup() {
  const { services } = createTestCms();
  const admin = contextFor("admin", services);
  return {
    pages: pagesRouter.createCaller(admin),
    posts: postsRouter.createCaller(admin),
    site: siteRouter.createCaller(admin),
    public: publicRouter.createCaller(contextFor("anonymous", services)),
  };
}

describe("public router", () => {
  it("serves a published page to an anonymous caller, and a miss for anything else", async () => {
    const { pages, public: pub } = setup();
    const made = await pages.createPage({ slug: "about", title: "About" });
    await pages.publishPage({
      pageId: made.ok ? made.id : "",
      draftVersion: 0,
    });
    const hit = await pub.loadCmsPage({ path: "/about" });
    expect("page" in hit && hit.page).toBeTruthy();
    const miss = await pub.loadCmsPage({ path: "/nope" });
    expect("page" in miss && miss.page).toBeFalsy();
  });

  it("reads the site doc: null until published", async () => {
    const { site, public: pub } = setup();
    expect(await pub.getRootSite()).toEqual({ site: null });
    const state = await site.getSite();
    await site.saveSiteDraft({
      draftVersion: 0,
      doc: state.ok ? state.doc : null,
    });
    await site.publishSite({ draftVersion: 1 });
    expect((await pub.getRootSite()).site).toBeTruthy();
  });

  it("lists published posts for /blog with the shaped fields", async () => {
    const { pages, posts, public: pub } = setup();
    expect(await pub.getBlogIndexData()).toEqual({ posts: [] });
    const made = await posts.createPost({
      title: "Hello",
      slug: "hello",
      category: "News",
      author: "Jane",
    });
    await pages.publishPage({
      pageId: made.ok ? made.id : "",
      draftVersion: 0,
    });
    const { posts: list } = await pub.getBlogIndexData();
    expect(list).toEqual([
      {
        slug: "hello",
        title: "Hello",
        description: expect.any(String),
        category: "News",
        tags: expect.any(Array),
        readingTime: expect.any(String),
        datePublished: expect.any(String),
        author: "Jane",
      },
    ]);
  });
});
