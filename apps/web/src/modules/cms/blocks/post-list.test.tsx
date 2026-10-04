import { describe, expect, it } from "bun:test";
import { selectPosts } from "@repo/cms-core/blocks/post-list";
import { createBlock } from "@repo/cms-core/blocks/registry";
import type { PostSummary } from "@repo/cms-core/posts";
import { sampleSeo } from "@repo/cms-core/test-fixtures";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EditModeContext } from "../render/edit-mode";
import { PageRenderer } from "../render/page-renderer";
import { CmsRenderContext } from "../render/render-context";

const summary = (
  slug: string,
  category: string,
  publishedAt: string
): PostSummary => ({
  slug: `blog/${slug}`,
  title: `Title ${slug}`,
  excerpt: `Excerpt ${slug}`,
  publishedAt,
  author: "Jane Doe",
  readingTime: 4,
  category,
  tags: [],
});

const POSTS = [
  summary("newest", "Tools", "2026-09-30"),
  summary("middle", "Strategy", "2026-08-15"),
  summary("oldest", "Tools", "2026-07-12"),
];

function render(
  props: Record<string, unknown>,
  opts: { posts?: PostSummary[]; editing?: boolean } = {}
): string {
  const b = createBlock("postList", { _key: "pl", props });
  let tree: ReactNode = (
    <PageRenderer doc={{ _schema: 1, seo: sampleSeo(), blocks: [b] }} />
  );
  tree = (
    <CmsRenderContext.Provider value={{ posts: opts.posts }}>
      {tree}
    </CmsRenderContext.Provider>
  );
  if (opts.editing) {
    tree = (
      <EditModeContext.Provider value={{ editing: true }}>
        {tree}
      </EditModeContext.Provider>
    );
  }
  return renderToStaticMarkup(tree);
}

describe("postList block", () => {
  it("selects the newest `limit` posts, optionally in one category (case-insensitive)", () => {
    expect(selectPosts(POSTS, { limit: 2 }).map((p) => p.slug)).toEqual([
      "blog/newest",
      "blog/middle",
    ]);
    expect(
      selectPosts(POSTS, { limit: 5, category: "tools" }).map((p) => p.slug)
    ).toEqual(["blog/newest", "blog/oldest"]);
    expect(
      selectPosts(POSTS, { limit: 3, category: " " }).map((p) => p.slug)
    ).toHaveLength(3);
  });

  it("renders cards linking to each post, with category, reading time, excerpt, author and date", () => {
    const html = render(
      { heading: "Latest", limit: 2, viewAllLabel: "All articles" },
      { posts: POSTS }
    );
    expect(html).toContain("Latest");
    expect(html).toContain('href="/blog/newest"');
    expect(html).toContain('href="/blog/middle"');
    expect(html).not.toContain("/blog/oldest");
    expect(html).toContain("Tools");
    expect(html).toContain("4 min read");
    expect(html).toContain("Excerpt newest");
    expect(html).toContain("Jane Doe · 30 September 2026");
    expect(html).toContain('href="/blog"');
  });

  it("shows only the category's posts when one is set", () => {
    const html = render({ limit: 3, category: "Strategy" }, { posts: POSTS });
    expect(html).toContain("/blog/middle");
    expect(html).not.toContain("/blog/newest");
  });

  it("with no posts to show: nothing at all on the site (not even its section and spacing), a placeholder in the editor", () => {
    expect(render({ limit: 3, viewAllLabel: "All articles" })).toBe("");
    expect(render({ limit: 3, category: "Nope" }, { posts: POSTS })).toBe("");
    const editor = render({ limit: 3 }, { editing: true });
    expect(editor).toContain("No published posts yet");
    expect(editor).toContain('data-cms-block="postList"');
  });
});
