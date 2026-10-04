import { describe, expect, it } from "bun:test";

import type { PageSummary } from "./page-summary";
import {
  blogIndexRobots,
  hasPublishedPosts,
  mergeSitemapPaths,
} from "./sitemap";

const at = "2026-10-01T12:00:00.000Z";

function cms(slug: string, patch: Partial<PageSummary> = {}): PageSummary {
  return {
    slug,
    kind: "page",
    title: "T",
    description: "",
    updatedAt: at,
    index: true,
    sitemapInclude: true,
    llmsInclude: true,
    ...patch,
  };
}

describe("mergeSitemapPaths", () => {
  it("keeps static paths unchanged with no CMS pages", () => {
    expect(mergeSitemapPaths(["", "/about"], [])).toEqual([
      { path: "" },
      { path: "/about" },
    ]);
  });

  it("lists a CMS page at a static path once, in place, with its publish date; home is '' in the static list", () => {
    expect(
      mergeSitemapPaths(["", "/about", "/faq"], [cms("about"), cms("")])
    ).toEqual([
      { path: "", lastmod: at },
      { path: "/about", lastmod: at },
      { path: "/faq" },
    ]);
  });

  it("appends CMS-only pages and drops noindex or sitemap-excluded ones, even at static paths", () => {
    const out = mergeSitemapPaths(
      ["/about", "/faq"],
      [
        cms("faq", { index: false }),
        cms("new"),
        cms("hidden", { sitemapInclude: false }),
      ]
    );
    expect(out).toEqual([{ path: "/about" }, { path: "/new", lastmod: at }]);
  });

  it("lists published posts (blog/<slug>) after the static paths, with their publish date", () => {
    expect(
      mergeSitemapPaths(
        ["", "/blog"],
        [
          cms("blog/b-post", { kind: "post" }),
          cms("blog/hidden", { kind: "post", index: false }),
        ]
      )
    ).toEqual([
      { path: "" },
      { path: "/blog" },
      { path: "/blog/b-post", lastmod: at },
    ]);
  });
});

describe("blog with no posts", () => {
  it("reports published posts only when the index has a post", () => {
    expect(hasPublishedPosts([])).toBe(false);
    expect(hasPublishedPosts([cms("about")])).toBe(false);
    expect(
      hasPublishedPosts([cms("about"), cms("blog/hello", { kind: "post" })])
    ).toBe(true);
  });

  it("noindexes /blog while it lists no posts", () => {
    expect(blogIndexRobots(0)).toBe("noindex, follow");
    expect(blogIndexRobots(3)).toBe("index, follow");
  });
});
