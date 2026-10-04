// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import { readPagesIndex, readPostsIndex } from "./pages-index";
import type { PageSummary } from "./pages-service";

const entry = (slug: string): PageSummary => ({
  slug,
  kind: slug.startsWith("blog/") ? "post" : "page",
  title: slug,
  description: "",
  updatedAt: "2026-10-01T00:00:00.000Z",
  index: true,
  sitemapInclude: true,
  llmsInclude: true,
});
const kvOf = (value: string | null) => ({ get: async () => value });

describe("readPagesIndex", () => {
  afterEach(() => mock.restore());

  it("returns live pages and posts at CMS-servable paths only", async () => {
    const all = [
      "",
      "login",
      "blog/x",
      "cms-test",
      "launch-event-2026-10-23",
      "admin/pages",
    ].map(entry);
    const out = await readPagesIndex(kvOf(JSON.stringify(all)));
    expect(out.map((e) => e.slug)).toEqual([
      "",
      "blog/x",
      "cms-test",
      "launch-event-2026-10-23",
    ]);
  });

  it("is empty with no index", async () => {
    expect(await readPagesIndex(kvOf(null))).toEqual([]);
  });

  it("logs and returns nothing on a KV failure or an unreadable index", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(
      await readPagesIndex({
        get: () => Promise.reject(new Error("KV unavailable")),
      })
    ).toEqual([]);
    expect(await readPagesIndex(kvOf("{not json"))).toEqual([]);
    expect(await readPagesIndex(kvOf('{"slug":"x"}'))).toEqual([]);
    expect(error).toHaveBeenCalledTimes(3);
  });
});

describe("readPostsIndex", () => {
  afterEach(() => mock.restore());

  it("returns posts:index as stored (newest first), and nothing when it's missing or unreadable", async () => {
    const posts = [{ slug: "blog/b" }, { slug: "blog/a" }];
    expect<unknown>(await readPostsIndex(kvOf(JSON.stringify(posts)))).toEqual(
      posts
    );
    expect(await readPostsIndex(kvOf(null))).toEqual([]);
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(await readPostsIndex(kvOf("{"))).toEqual([]);
    expect(await readPostsIndex(kvOf("{}"))).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
