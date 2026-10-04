import { describe, expect, it } from "bun:test";
import type { PageSummary } from "@repo/cms-core/page-summary";
import { sitemapResponse, sitemapXml } from "./sitemap";

const CONFIG = { origin: "https://example.com" };

const page = (over: Partial<PageSummary>): PageSummary => ({
  slug: "about",
  kind: "page",
  title: "About",
  description: "",
  updatedAt: "2026-03-04T05:06:07.000Z",
  index: true,
  sitemapInclude: true,
  llmsInclude: false,
  ...over,
});

const locs = (xml: string) =>
  [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

describe("sitemap.xml", () => {
  it("is an empty urlset with nothing published", () => {
    const xml = sitemapXml(CONFIG, []);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    );
    expect(locs(xml)).toEqual([]);
  });

  it("lists published pages on the configured origin with a day lastmod", () => {
    const xml = sitemapXml(CONFIG, [page({ slug: "" }), page({})]);
    expect(locs(xml)).toEqual([
      "https://example.com",
      "https://example.com/about",
    ]);
    expect(xml).toContain("<lastmod>2026-03-04</lastmod>");
  });

  it("lists /blog once a post is published, and leaves out noindex and excluded pages", () => {
    const xml = sitemapXml(CONFIG, [
      page({ slug: "blog/hello", kind: "post", lastmod: "2026-05-01" }),
      page({ slug: "hidden", index: false }),
      page({ slug: "skip", sitemapInclude: false }),
    ]);
    expect(locs(xml)).toEqual([
      "https://example.com/blog",
      "https://example.com/blog/hello",
    ]);
    expect(xml).toContain("<lastmod>2026-05-01</lastmod>");
  });

  it("escapes XML in locations", () => {
    const xml = sitemapXml({ origin: "https://a.com/?x=1&y=2" }, [page({})]);
    expect(xml).toContain("x=1&amp;y=2");
  });

  it("serves XML, cached for an hour", () => {
    const res = sitemapResponse(CONFIG, []);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });
});
