import { describe, expect, it } from "bun:test";

import { doc } from "@repo/cms-core/ops/test-docs";
import type { PostSummary } from "@repo/cms-core/posts";
import { defaultSeo } from "@repo/cms-core/site/seo-defaults";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";

import {
  cmsHead,
  cmsHeaders,
  cmsPageData,
  PREVIEW_HEADERS,
  previewToken,
} from "./cms-result";

/** The root match a route `head` sees: the root loader's site doc (none published) and SiteConfig. */
const ROOT = {
  routeId: "__root__",
  loaderData: { site: null, config: TEST_CONFIG },
};

const titleOf = (head: ReturnType<typeof cmsHead>) =>
  head.meta.find((m) => "title" in m)?.title;

describe("previewToken", () => {
  it("takes a non-empty string _preview and ignores anything else", () => {
    expect(previewToken({ _preview: "abc.def" })).toBe("abc.def");
    expect(previewToken({})).toBeUndefined();
    expect(previewToken({ _preview: "" })).toBeUndefined();
    // The router JSON-parses search values.
    expect(previewToken({ _preview: 123 })).toBeUndefined();
    expect(previewToken({ _preview: { a: 1 } })).toBeUndefined();
    expect(previewToken({ _preview: "x".repeat(1025) })).toBeUndefined();
    expect(previewToken(null)).toBeUndefined();
  });
});

describe("draft previews in loader data", () => {
  const live = doc();

  it("cmsPageData parses the posts index for a postList page; an unreadable one is no posts", () => {
    const page = JSON.stringify({ doc: live });
    expect(
      cmsPageData({ page, parents: [], posts: '[{"slug":"blog/a"}]' })?.posts
    ).toEqual([{ slug: "blog/a" }] as PostSummary[]);
    expect(cmsPageData({ page, parents: [], posts: "{oops" })?.posts).toEqual(
      []
    );
    expect(cmsPageData({ page, parents: [] })).not.toHaveProperty("posts");
  });

  it("cmsPageData passes the preview flag through, and only when set", () => {
    const page = JSON.stringify({ doc: live });
    expect(cmsPageData({ page, parents: [] })).not.toHaveProperty("preview");
    expect(cmsPageData({ page, parents: [], preview: true })).toMatchObject({
      preview: true,
      doc: live,
    });
  });

  it("cmsHead makes a preview noindex, nofollow and leaves the live head alone", () => {
    const data = { doc: live, path: "/", parents: [] };
    const robots = (head: ReturnType<typeof cmsHead>) =>
      head.meta.filter((m) => "name" in m && m.name === "robots");
    expect(robots(cmsHead(data, [ROOT]))).toEqual([
      { name: "robots", content: "index, follow" },
    ]);
    const preview = cmsHead({ ...data, preview: true }, [ROOT]);
    expect(robots(preview)).toEqual([
      { name: "robots", content: "noindex, nofollow" },
    ]);
    expect(preview.meta.length).toBe(cmsHead(data, [ROOT]).meta.length);
  });

  it("cmsHeaders: no-store and noindex for a preview only", () => {
    expect(
      cmsHeaders({ doc: live, path: "/", parents: [], preview: true })
    ).toEqual(PREVIEW_HEADERS);
    expect(PREVIEW_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    expect(cmsHeaders({ doc: live, path: "/", parents: [] })).toBeUndefined();
    expect(cmsHeaders(null)).toBeUndefined();
  });
});

describe("cmsHead", () => {
  const cms = { doc: doc(), path: "/x", parents: [] };

  it("reads the site doc's SEO defaults and the SiteConfig from the root match's loader data", () => {
    const seo = { ...defaultSeo(TEST_CONFIG), titleTemplate: "%s · Example" };
    const root = {
      routeId: "__root__",
      loaderData: { site: { seo }, config: TEST_CONFIG },
    };
    expect(
      titleOf(cmsHead(cms, [root, { routeId: "/$", loaderData: {} }]))
    ).toBe("Home · Example");
    const canonical = cmsHead(cms, [root]).links[0]?.href;
    expect(canonical).toBe(`${TEST_CONFIG.origin}/x`);
  });

  it("uses the defaults for the SiteConfig's name when no site doc is published", () => {
    expect(titleOf(cmsHead(cms, [ROOT]))).toBe(`Home | ${TEST_CONFIG.name}`);
  });

  it("throws without the root loader data: there is no default origin", () => {
    expect(() => cmsHead(cms, [])).toThrow();
  });
});
