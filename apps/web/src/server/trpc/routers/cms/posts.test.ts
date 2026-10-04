import { describe, expect, it } from "bun:test";
import { postsRouter } from "./posts.ts";
import { contextFor, createTestCms } from "./test-context.ts";

function setup() {
  const { services } = createTestCms();
  return postsRouter.createCaller(contextFor("admin", services));
}

describe("posts router", () => {
  it("is admin only", async () => {
    await expect(
      postsRouter.createCaller(contextFor("user")).listPosts()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a post under blog/ and lists it", async () => {
    const caller = setup();
    const made = await caller.createPost({
      title: " Hello ",
      slug: "hello",
      category: " News ",
      author: "Jane",
    });
    expect(made).toMatchObject({ ok: true, id: expect.any(String) });
    const list = await caller.listPosts();
    expect(list.ok && list.posts[0]).toMatchObject({
      slug: "blog/hello",
      title: "Hello",
      category: "News",
      author: "Jane",
      status: "draft",
    });
    expect(await caller.checkPostSlug({ slug: "hello" })).toMatchObject({
      ok: false,
      code: "SLUG_TAKEN",
    });
    expect(await caller.publishedPosts()).toEqual({ ok: true, posts: [] });
  });
});
