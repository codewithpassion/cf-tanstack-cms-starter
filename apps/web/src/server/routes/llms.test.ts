import { describe, expect, it } from "bun:test";
import { llmsFullTxt, llmsTxt } from "@repo/cms-core/llms-intro";
import type { PageSummary } from "@repo/cms-core/page-summary";
import { llmsBody, llmsTxtResponse } from "./llms";

const CONFIG = { name: "Example Site", origin: "https://example.com" };

const page = (over: Partial<PageSummary>): PageSummary => ({
  slug: "about",
  kind: "page",
  title: "About",
  description: "Who we are",
  updatedAt: "2026-03-04T05:06:07.000Z",
  index: true,
  sitemapInclude: true,
  llmsInclude: true,
  ...over,
});

describe("llms.txt", () => {
  it("is the intro unchanged when no page opts in", () => {
    expect(llmsBody("llms", CONFIG, [page({ llmsInclude: false })])).toBe(
      llmsTxt(CONFIG)
    );
    expect(llmsBody("llms-full", CONFIG, [])).toBe(llmsFullTxt(CONFIG));
  });

  it("names the site and links pages and posts on the configured origin", () => {
    const body = llmsBody("llms", CONFIG, [
      page({}),
      page({
        slug: "blog/hello",
        kind: "post",
        title: "Hello",
        llmsSummary: "First post",
      }),
    ]);
    expect(body.startsWith("# Example Site\n")).toBe(true);
    expect(body).toContain(
      "## More Pages\n\n- [About](https://example.com/about): Who we are"
    );
    expect(body).toContain(
      "## Blog Posts\n\n- [Hello](https://example.com/blog/hello): First post"
    );
  });

  it("llms-full carries the details section the short file lacks", () => {
    expect(llmsBody("llms-full", CONFIG, [])).toContain("## Details");
    expect(llmsBody("llms", CONFIG, [])).not.toContain("## Details");
  });

  it("serves plain text, cached for an hour", async () => {
    const res = llmsTxtResponse("llms", CONFIG, []);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await res.text()).toBe(llmsTxt(CONFIG));
  });
});
