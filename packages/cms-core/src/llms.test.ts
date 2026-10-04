import { describe, expect, it } from "bun:test";

import { withCmsPages } from "./llms";
import type { PageSummary } from "./page-summary";
import { TEST_CONFIG } from "./test-fixtures";

function page(slug: string, patch: Partial<PageSummary> = {}): PageSummary {
  return {
    slug,
    kind: "page",
    title: "Sample page",
    description: "A sample page.",
    updatedAt: "2026-10-01T12:00:00.000Z",
    index: true,
    sitemapInclude: true,
    llmsInclude: true,
    ...patch,
  };
}

describe("withCmsPages", () => {
  const base = "# Site\n\nHand-written.\n";

  it("returns the text unchanged when no page opts in", () => {
    expect(withCmsPages(base, [], TEST_CONFIG)).toBe(base);
    expect(
      withCmsPages(base, [page("x", { llmsInclude: false })], TEST_CONFIG)
    ).toBe(base);
  });

  it("appends opted-in pages with their summary, else description", () => {
    const out = withCmsPages(
      base,
      [
        page("a", { llmsSummary: "Summary A." }),
        page("b", { llmsInclude: false }),
        page("c"),
        page(""),
      ],
      TEST_CONFIG
    );
    expect(out).toBe(
      `${base}\n## More Pages\n\n` +
        "- [Sample page](https://example.com/a): Summary A.\n" +
        "- [Sample page](https://example.com/c): A sample page.\n" +
        "- [Sample page](https://example.com): A sample page.\n"
    );
  });

  it("lists opted-in posts under their own heading, after the pages", () => {
    const out = withCmsPages(
      base,
      [
        page("blog/b-post", {
          kind: "post",
          title: "B post",
          description: "About B.",
        }),
        page("a"),
        page("blog/hidden", { kind: "post", llmsInclude: false }),
      ],
      TEST_CONFIG
    );
    expect(out).toBe(
      `${base}\n## More Pages\n\n` +
        "- [Sample page](https://example.com/a): A sample page.\n" +
        "\n## Blog Posts\n\n" +
        "- [B post](https://example.com/blog/b-post): About B.\n"
    );
  });
});
