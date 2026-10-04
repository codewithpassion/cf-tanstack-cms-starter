// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noShadow: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";
import { pagePerformance, seoGscOverview, strikingRows } from "./gsc.ts";
import {
  gscInspections,
  gscPageDays,
  gscRows,
  pages,
  revisionLabels,
  revisions,
} from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

const U = "https://example.com";
const pageUrl = (slug: string) => `${U}/${slug}`;
type Db = ReturnType<typeof createTestDb>["db"];

const row = (
  date: string,
  page: string,
  query: string,
  impressions: number,
  position: number,
  clicks = 0,
  device = "DESKTOP"
) => ({
  date,
  page,
  query,
  device,
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});
const day = (
  date: string,
  page: string,
  impressions: number,
  position: number,
  clicks = 0
) => ({
  date,
  page,
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

async function seedPage(
  db: Db,
  id: string,
  slug: string,
  status: "draft" | "published",
  opts: { index?: boolean; publishedAt?: number[] } = {}
) {
  const doc = {
    _schema: 1,
    seo: { robots: { index: opts.index ?? true, follow: true } },
    blocks: [],
  } as never;
  const revs = (opts.publishedAt ?? []).map((t, i) => ({
    id: `${id}-r${i}`,
    pageId: id,
    docJson: doc,
    kind: "published" as const,
    createdAt: new Date(t),
  }));
  await db.insert(pages).values({
    id,
    kind: "page",
    slug,
    title: `Title ${id}`,
    status,
    draftDoc: doc,
    liveRevId: revs.at(-1)?.id ?? null,
    updatedAt: new Date(0),
  });
  if (revs.length) {
    await db.insert(revisions).values(revs);
  }
}

describe("strikingRows (SQL)", () => {
  it("aggregates each page × query over days and devices before applying the 4–20 band and the impressions floor", async () => {
    const { db } = createTestDb();
    await db.insert(gscRows).values([
      // Averages to position 8 over 30 impressions: in, though one day alone ranks 2.
      row("2026-09-10", `${U}/a`, "ai consulting", 10, 2),
      row("2026-09-11", `${U}/a`, "ai consulting", 20, 11, 0, "MOBILE"),
      // Averages to 30: out, though one day alone ranks 6.
      row("2026-09-10", `${U}/a`, "far away", 10, 6),
      row("2026-09-11", `${U}/a`, "far away", 40, 36),
      // 6 + 6 impressions: in only because the days add up to the floor.
      row("2026-09-10", `${U}/b`, "split", 6, 9),
      row("2026-09-12", `${U}/b`, "split", 6, 9),
      // Too few impressions.
      row("2026-09-10", `${U}/b`, "rare", 5, 9),
      // Outside the window.
      row("2026-08-01", `${U}/b`, "old", 500, 9),
    ]);
    const rows = await strikingRows(
      db,
      { start: "2026-09-01", end: "2026-09-29" },
      10
    );
    expect(rows).toEqual([
      {
        page: `${U}/a`,
        query: "ai consulting",
        clicks: 0,
        impressions: 30,
        position: 8,
      },
      {
        page: `${U}/b`,
        query: "split",
        clicks: 0,
        impressions: 12,
        position: 9,
      },
    ]);
  });
});

describe("seoGscOverview", () => {
  it("totals the last 28 days of data per CMS page and builds both Opportunities lists", async () => {
    const { db } = createTestDb();
    await seedPage(db, "home", "", "draft");
    await seedPage(db, "about", "about", "published", { publishedAt: [1] });
    await seedPage(db, "hidden", "hidden", "published", {
      index: false,
      publishedAt: [1],
    });
    await seedPage(db, "fresh", "fresh", "published", { publishedAt: [1] });
    await db.insert(gscPageDays).values([
      day("2026-09-29", `${U}/`, 30, 4, 3),
      day("2026-09-02", `${U}/`, 10, 8, 1),
      // One day before the 28-day window that ends at the newest date (09-29).
      day("2026-09-01", `${U}/`, 1000, 50, 100),
      day("2026-09-20", `${U}/about`, 5, 12),
      // Not a CMS page: no column, but its queries still count as opportunities.
      day("2026-09-20", `${U}/locations/brisbane`, 400, 9),
    ]);
    await db
      .insert(gscRows)
      .values([
        row("2026-09-20", `${U}/locations/brisbane`, "ai brisbane", 300, 9),
        row("2026-09-20", `${U}/`, "acme widgets", 20, 5),
      ]);
    await db.insert(gscInspections).values([
      { page: `${U}/about`, checkedAt: new Date(1), verdict: "PASS" },
      {
        page: `${U}/about`,
        checkedAt: new Date(2),
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
      },
      {
        page: `${U}/hidden`,
        checkedAt: new Date(2),
        verdict: "NEUTRAL",
        coverageState: "Excluded by 'noindex' tag",
      },
    ]);

    const o = await seoGscOverview(db, { pageUrl, minImpressions: 10 });
    expect(o.range).toEqual({ start: "2026-09-02", end: "2026-09-29" });
    expect(o.byPageId).toEqual({
      home: { clicks: 4, impressions: 40, ctr: 0.1, position: 5 },
      about: { clicks: 0, impressions: 5, ctr: 0, position: 12 },
    });
    expect(
      o.striking.map((s) => [s.page, s.pageId, s.queries.map((q) => q.query)])
    ).toEqual([
      [`${U}/locations/brisbane`, null, ["ai brisbane"]],
      [`${U}/`, "home", ["acme widgets"]],
    ]);
    // The latest inspection counts; noindex pages and drafts are left out.
    expect(
      o.notIndexed.map((n) => [n.pageId, n.inspection?.coverageState ?? null])
    ).toEqual([
      ["fresh", null],
      ["about", "Crawled - currently not indexed"],
    ]);
  });

  it("reads only each page's newest inspection, not the history", async () => {
    const { db, log } = createTestDb();
    await seedPage(db, "about", "about", "published", { publishedAt: [1] });
    await db.insert(gscInspections).values([
      {
        page: `${U}/about`,
        checkedAt: new Date(1),
        verdict: "NEUTRAL",
        coverageState: "old",
      },
      {
        page: `${U}/about`,
        checkedAt: new Date(3),
        verdict: "NEUTRAL",
        coverageState: "newest",
      },
      { page: `${U}/about`, checkedAt: new Date(2), verdict: "PASS" },
    ]);
    const before = log.length;
    const o = await seoGscOverview(db, { pageUrl });
    expect(o.notIndexed.map((n) => n.inspection?.coverageState)).toEqual([
      "newest",
    ]);
    const inspectionReads = log
      .slice(before)
      .filter((l) => /from "gsc_inspections"/.test(l.sql));
    expect(inspectionReads).toHaveLength(1);
    // The newest checked_at per page, joined back to its row.
    expect(inspectionReads[0]!.sql).toMatch(
      /inner join \(select .*max\(.*checked_at.*group by/
    );
  });

  it("marks a page first published under 3 days ago as pending, judged by its first publish", async () => {
    const { db } = createTestDb();
    const now = Date.parse("2026-10-02T00:00:00Z");
    const day = 24 * 60 * 60_000;
    await seedPage(db, "new", "new", "published", { publishedAt: [now - day] });
    // Republished yesterday, but first published long ago: a real problem.
    await seedPage(db, "old", "old", "published", {
      publishedAt: [now - 90 * day, now - day],
    });
    const o = await seoGscOverview(db, { pageUrl, minImpressions: 10, now });
    expect(o.notIndexed.map((n) => [n.pageId, n.pending])).toEqual([
      ["old", false],
      ["new", true],
    ]);
  });

  it("works before any data was synced", async () => {
    const { db } = createTestDb();
    await seedPage(db, "about", "about", "published", { publishedAt: [1] });
    const o = await seoGscOverview(db, { pageUrl });
    expect(o).toMatchObject({
      range: null,
      byPageId: {},
      striking: [],
      minImpressions: 10,
    });
    expect(o.notIndexed.map((n) => n.pageId)).toEqual(["about"]);
  });
});

describe("pagePerformance", () => {
  it("returns totals, a full daily series, publish markers and top queries for the page's URL", async () => {
    const { db } = createTestDb();
    await seedPage(db, "home", "", "published", {
      publishedAt: [
        Date.parse("2026-09-25T20:00:00Z"),
        Date.parse("2026-01-01T00:00:00Z"),
        Date.parse("2026-10-01T20:00:00Z"),
        Date.parse("2026-10-03T20:00:00Z"),
      ],
    });
    await db
      .insert(gscPageDays)
      .values([
        day("2026-09-29", `${U}/`, 30, 4, 3),
        day("2026-09-28", `${U}/`, 10, 8, 1),
        day("2026-09-29", `${U}/about`, 999, 1, 99),
      ]);
    await db
      .insert(gscRows)
      .values([
        row("2026-09-29", `${U}/`, "b query", 20, 3, 2),
        row("2026-09-28", `${U}/`, "b query", 10, 6, 0, "MOBILE"),
        row("2026-09-29", `${U}/`, "a query", 5, 2, 2),
        row("2026-09-29", `${U}/`, "c query", 50, 9, 0),
        row("2026-09-29", `${U}/about`, "elsewhere", 500, 1, 50),
      ]);
    await db.insert(gscInspections).values({
      page: `${U}/`,
      checkedAt: new Date(5),
      verdict: "PASS",
      lastCrawl: "2026-09-30T01:00:00Z",
      googleCanonical: `${U}/`,
    });
    // A marker shows a revision's display label: its rename wins.
    await db.insert(revisionLabels).values({
      revId: "home-r2",
      label: "Renamed",
      pinned: false,
      updatedAt: new Date(0),
    });

    const p = await pagePerformance(db, { id: "home", slug: "" }, 28, {
      pageUrl,
      now: Date.parse("2026-10-02T20:00:00Z"),
    });
    expect(p.url).toBe(`${U}/`);
    expect(p.range).toEqual({ start: "2026-09-02", end: "2026-09-29" });
    expect(p.totals).toEqual({
      clicks: 4,
      impressions: 40,
      ctr: 0.1,
      position: 5,
    });
    expect(p.series).toHaveLength(28);
    expect(p.series.at(-1)).toMatchObject({
      date: "2026-09-29",
      impressions: 30,
    });
    expect(p.series[0]).toMatchObject({
      date: "2026-09-02",
      impressions: 0,
      position: null,
    });
    // The chart runs on to today, so a publish after the newest data still gets a marker.
    expect(p.chartEnd).toBe("2026-10-02");
    expect(p.markers).toEqual([
      { date: "2026-09-25", count: 1, revIds: ["home-r0"], labels: [] },
      {
        date: "2026-10-01",
        count: 1,
        revIds: ["home-r2"],
        labels: ["Renamed"],
      },
    ]);
    // Clicks first, then impressions; positions impression-weighted across days and devices.
    expect(
      p.topQueries.map((q) => [q.query, q.clicks, q.impressions, q.position])
    ).toEqual([
      ["b query", 2, 30, 4],
      ["a query", 2, 5, 2],
      ["c query", 0, 50, 9],
    ]);
    expect(p.inspection).toMatchObject({
      verdict: "PASS",
      lastCrawl: "2026-09-30T01:00:00Z",
    });
  });

  it("has no range or series before any data was synced", async () => {
    const { db } = createTestDb();
    const p = await pagePerformance(db, { id: "x", slug: "new" }, 90, {
      pageUrl,
    });
    expect(p).toMatchObject({
      url: `${U}/new`,
      days: 90,
      range: null,
      series: [],
      topQueries: [],
      inspection: null,
    });
  });
});
