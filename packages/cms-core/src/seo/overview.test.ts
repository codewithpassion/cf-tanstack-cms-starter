// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim; each assertion follows a length or membership check.
import { describe, expect, it } from "bun:test";

import { defaultSeo } from "../site/seo-defaults";
import type { PublicSiteSeo } from "../site/types";
import { MEDIA_ID, sampleDoc, TEST_CONFIG } from "../test-fixtures";
import type { PageDoc, PageSeo } from "../types";
import {
  buildSeoOverview as buildSeoOverviewFor,
  type DraftSeoSummary,
  otherPageFromSummary as otherPageFromSummaryFor,
  otherPagesFrom as otherPagesFromFor,
  type SeoPageInput,
} from "./overview";
import { rowsWithIssues, sortSeoRows, withGscMetrics } from "./overview-table";

const DEFAULT_SEO = defaultSeo(TEST_CONFIG);

const buildSeoOverview = (
  pages: SeoPageInput[],
  media: Parameters<typeof buildSeoOverviewFor>[1],
  site?: PublicSiteSeo
) => buildSeoOverviewFor(pages, media, TEST_CONFIG, site);
const otherPagesFrom = (pages: SeoPageInput[], site?: PublicSiteSeo) =>
  otherPagesFromFor(pages, TEST_CONFIG, site);
const otherPageFromSummary = (p: DraftSeoSummary, site?: PublicSiteSeo) =>
  otherPageFromSummaryFor(p, TEST_CONFIG, site);

function page(
  id: string,
  seo: Partial<PageSeo>,
  status: SeoPageInput["status"] = "published"
): SeoPageInput {
  const doc: PageDoc = sampleDoc();
  doc.seo = { ...doc.seo, ...seo };
  return {
    id,
    kind: "page",
    slug: doc.seo.slug,
    title: `Page ${id}`,
    status,
    doc,
  };
}

describe("buildSeoOverview", () => {
  const pages = [
    page("a", {
      slug: "alpha",
      title: "Shared",
      description: "Same description",
    }),
    page("b", {
      slug: "beta",
      title: "Shared",
      description: "Same description",
      social: { image: { mediaId: MEDIA_ID, alt: "x" } },
    }),
    page(
      "c",
      {
        slug: "gamma",
        title: "Unique",
        description: "Other",
        robots: { index: false, follow: true },
        sitemap: { include: true },
      },
      "draft"
    ),
    page("d", { slug: "delta", title: "Shared" }, "archived"),
  ];
  const rows = buildSeoOverview(pages, {
    [MEDIA_ID]: { width: 1200, height: 630 },
  });

  it("leaves archived pages out, also as duplicates", () => {
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(otherPagesFrom(pages).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("gives the same title and description from a draft's SEO summary as from its document", () => {
    for (const p of [
      page("x", { title: "Pricing", description: " Plans " }),
      page("y", { title: "Exact", titleExact: true }),
    ]) {
      const { seo } = p.doc;
      const summary = {
        id: p.id,
        slug: seo.slug,
        title: seo.title,
        titleExact: seo.titleExact === true,
        description: seo.description,
      };
      expect<unknown>(otherPageFromSummary(summary)).toEqual(
        otherPagesFrom([p])[0]
      );
    }
  });

  it("applies the published site's title template to every title (rows, duplicates, summaries)", () => {
    const site = { ...DEFAULT_SEO, titleTemplate: "ACME · %s" };
    const custom = buildSeoOverview(pages, {}, site);
    expect(custom.map((r) => r.seoTitle)).toEqual([
      "ACME · Shared",
      "ACME · Shared",
      "ACME · Unique",
    ]);
    expect(custom[0]!.duplicateTitle).toBe(true);
    const p = page("x", { title: "Pricing" });
    const { seo } = p.doc;
    const summary = {
      id: p.id,
      slug: seo.slug,
      title: seo.title,
      titleExact: false,
      description: seo.description,
    };
    expect<unknown>(otherPageFromSummary(summary, site)).toEqual(
      otherPagesFrom([p], site)[0]
    );
    expect(otherPageFromSummary(summary, site).title).toBe("ACME · Pricing");
  });

  it("flags duplicate titles and descriptions on both pages", () => {
    const [a, b, c] = rows;
    expect([a!.duplicateTitle, b!.duplicateTitle, c!.duplicateTitle]).toEqual([
      true,
      true,
      false,
    ]);
    expect([
      a!.duplicateDescription,
      b!.duplicateDescription,
      c!.duplicateDescription,
    ]).toEqual([true, true, false]);
    expect(a!.issues[0]).toMatchObject({
      id: "title-unique",
      status: "fail",
      message: "Same title as /beta.",
    });
  });

  it("shapes effective values, share image and sitemap state", () => {
    const [a, b, c] = rows;
    expect(a).toMatchObject({
      path: "/alpha",
      pageTitle: "Page a",
      seoTitle: "Shared | Example Site",
      index: true,
      sitemap: true,
      shareImage: {
        src: "/og-image.jpg",
        isDefault: true,
        width: null,
        height: null,
      },
    });
    expect(b!.shareImage).toEqual({
      src: `/media/${MEDIA_ID}`,
      isDefault: false,
      width: 1200,
      height: 630,
    });
    // noindex pages never reach the sitemap, whatever the switch says.
    expect(c).toMatchObject({ index: false, sitemap: false, status: "draft" });
  });

  it("puts failures before warnings and scores each page", () => {
    for (const row of rows) {
      const firstWarn = row.issues.findIndex((i) => i.status === "warn");
      expect(
        row.issues
          .slice(firstWarn < 0 ? row.issues.length : firstWarn)
          .every((i) => i.status === "warn")
      ).toBe(true);
      expect(row.fails + row.warns).toBe(row.issues.length);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
    expect(rows[2]!.score).toBeGreaterThan(rows[0]!.score); // c has no duplicate failure
  });
});

describe("sortSeoRows / rowsWithIssues", () => {
  const rows = buildSeoOverview(
    [
      page("a", { slug: "b-page", title: "Zed" }),
      page("b", { slug: "a-page", title: "Alpha" }),
      page("c", { slug: "c-page", title: "Alpha" }),
    ],
    {}
  );

  it("sorts by a column in either direction, ties by path", () => {
    expect(sortSeoRows(rows, "seoTitle", "asc").map((r) => r.path)).toEqual([
      "/a-page",
      "/c-page",
      "/b-page",
    ]);
    expect(sortSeoRows(rows, "seoTitle", "desc").map((r) => r.path)).toEqual([
      "/b-page",
      "/a-page",
      "/c-page",
    ]);
    expect(sortSeoRows(rows, "path", "asc").map((r) => r.path)).toEqual([
      "/a-page",
      "/b-page",
      "/c-page",
    ]);
  });

  it("sorts by issues with failures first", () => {
    const sorted = sortSeoRows(rows, "issues", "desc");
    expect(sorted[0]!.fails).toBeGreaterThanOrEqual(sorted[2]!.fails);
    expect(sorted.slice(0, 2).every((r) => r.duplicateTitle)).toBe(true);
  });

  it("doesn't mutate its input", () => {
    const before = rows.map((r) => r.id);
    sortSeoRows(rows, "score", "desc");
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("adds Search Console totals by page id and sorts by them, pages without data last", () => {
    const metrics = (
      clicks: number,
      impressions: number,
      position: number
    ) => ({ clicks, impressions, ctr: clicks / impressions, position });
    const merged = withGscMetrics(rows, {
      a: metrics(5, 100, 12),
      c: metrics(9, 50, 3),
    });
    expect(merged.map((r) => r.gsc?.clicks ?? null)).toEqual([5, null, 9]);
    expect(sortSeoRows(merged, "clicks", "desc").map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(sortSeoRows(merged, "impressions", "desc").map((r) => r.id)).toEqual(
      ["a", "c", "b"]
    );
    expect(sortSeoRows(merged, "position", "asc").map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    // "—" rows stay last in the other direction too.
    expect(sortSeoRows(merged, "clicks", "asc").map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(sortSeoRows(merged, "position", "desc").map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("filters to rows with issues", () => {
    const clean = {
      ...rows[0]!,
      fails: 0,
      warns: 0,
      duplicateTitle: false,
      duplicateDescription: false,
      issues: [],
    };
    expect(rowsWithIssues([clean, rows[1]!])).toEqual([rows[1]!]);
  });
});
