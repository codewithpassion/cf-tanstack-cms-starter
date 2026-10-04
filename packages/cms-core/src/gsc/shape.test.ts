// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
import { describe, expect, it } from "bun:test";

import {
  addDays,
  backfillWindows,
  fillSeries,
  GSC_RETENTION_MONTHS,
  groupStriking,
  gscDayOf,
  type Inspection,
  metricsFromSums,
  notIndexed,
  pageUrl,
  pickInspectionTargets,
  publishMarkers,
  type QueryRow,
  REINSPECT_AFTER_MS,
  totalsOf,
  windowEndingAt,
} from "./shape";

const at = (iso: string) => Date.parse(iso);
const CONFIG = { origin: "https://example.com" };

describe("URLs and dates", () => {
  it("maps slugs to the URLs Search Console reports (home with a trailing slash)", () => {
    expect(pageUrl("", CONFIG)).toBe("https://example.com/");
    expect(pageUrl("services/automation-sprint", CONFIG)).toBe(
      "https://example.com/services/automation-sprint"
    );
  });

  it("counts windows inclusively and across month ends", () => {
    expect(windowEndingAt("2026-09-29", 28)).toEqual({
      start: "2026-09-02",
      end: "2026-09-29",
    });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("puts a moment on its Pacific-time day, as Search Console does", () => {
    // 06:00 UTC on the 10th is still the 9th in California (PDT, UTC-7).
    expect(gscDayOf(at("2026-09-10T06:00:00Z"))).toBe("2026-09-09");
    expect(gscDayOf(at("2026-09-10T08:00:00Z"))).toBe("2026-09-10");
    // Zero-padded, from the date's parts.
    expect(gscDayOf(at("2026-01-05T12:00:00Z"))).toBe("2026-01-05");
  });
});

describe("metrics", () => {
  it("weights position by impressions and guards zero impressions", () => {
    expect(
      metricsFromSums({ clicks: 3, impressions: 30, positionWeight: 150 })
    ).toEqual({ clicks: 3, impressions: 30, ctr: 0.1, position: 5 });
    expect(
      metricsFromSums({ clicks: 0, impressions: 0, positionWeight: 0 })
    ).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: null });
  });

  it("totals a series the same way", () => {
    const t = totalsOf([
      { date: "a", clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
      { date: "b", clicks: 0, impressions: 30, ctr: 0, position: 10 },
      { date: "c", clicks: 0, impressions: 0, ctr: 0, position: null },
    ]);
    expect(t).toEqual({ clicks: 1, impressions: 40, ctr: 0.025, position: 8 });
  });

  it("fills days without rows with zeros", () => {
    const series = fillSeries(
      [
        {
          date: "2026-09-02",
          clicks: 2,
          impressions: 5,
          ctr: 0.4,
          position: 3,
        },
      ],
      "2026-09-01",
      "2026-09-03"
    );
    expect(series.map((d) => [d.date, d.impressions, d.position])).toEqual([
      ["2026-09-01", 0, null],
      ["2026-09-02", 5, 3],
      ["2026-09-03", 0, null],
    ]);
  });
});

describe("publishMarkers", () => {
  const revs = [
    {
      id: "r3",
      createdAt: at("2026-09-20T20:00:00Z"),
      label: "Pricing update",
    },
    { id: "r1", createdAt: at("2026-09-10T08:00:00Z"), label: null },
    // Same Pacific day as r1 (10th, 01:00 and 15:00 PDT): merged into one marker.
    { id: "r2", createdAt: at("2026-09-10T22:00:00Z"), label: "Hero copy" },
    // Before the window.
    { id: "r0", createdAt: at("2026-08-01T12:00:00Z"), label: "Old" },
    // UTC-wise the 30th, but the 29th in Pacific time: inside a window ending on the 29th.
    { id: "r4", createdAt: at("2026-09-30T05:00:00Z"), label: null },
    // After the window.
    { id: "r5", createdAt: at("2026-09-30T12:00:00Z"), label: null },
  ];

  it("merges publishes on the same Search Console day and keeps only the window, in date order", () => {
    expect(publishMarkers(revs, "2026-09-02", "2026-09-29")).toEqual([
      {
        date: "2026-09-10",
        count: 2,
        revIds: ["r1", "r2"],
        labels: ["Hero copy"],
      },
      {
        date: "2026-09-20",
        count: 1,
        revIds: ["r3"],
        labels: ["Pricing update"],
      },
      { date: "2026-09-29", count: 1, revIds: ["r4"], labels: [] },
    ]);
  });

  it("is empty without publishes in the window", () => {
    expect(publishMarkers(revs, "2025-01-01", "2025-01-31")).toEqual([]);
    expect(publishMarkers([], "2026-09-02", "2026-09-29")).toEqual([]);
  });
});

describe("groupStriking", () => {
  const q = (
    page: string,
    query: string,
    impressions: number,
    position: number
  ): QueryRow => ({ page, query, clicks: 0, impressions, position });
  const rows = [
    q("https://h/a", "ai consulting", 40, 8),
    q("https://h/a", "ai consultant", 12, 15),
    q("https://h/b", "ai strategy", 100, 5.5),
    q("https://h/a", "too high", 500, 3.9),
    q("https://h/a", "too low", 500, 20.1),
    q("https://h/c", "too few", 9, 6),
  ];

  it("keeps positions 4–20 with enough impressions, groups by page, orders by impressions", () => {
    const groups = groupStriking(
      rows,
      10,
      new Map([["https://h/a", "page-a"]])
    );
    expect(
      groups.map((g) => [
        g.page,
        g.pageId,
        g.impressions,
        g.queries.map((x) => x.query),
      ])
    ).toEqual([
      ["https://h/b", null, 100, ["ai strategy"]],
      ["https://h/a", "page-a", 52, ["ai consulting", "ai consultant"]],
    ]);
  });

  it("includes the edges of the band", () => {
    expect(
      groupStriking(
        [q("p", "four", 10, 4), q("p", "twenty", 10, 20)],
        10,
        new Map()
      )[0]!.queries
    ).toHaveLength(2);
  });
});

describe("notIndexed", () => {
  const inspection = (page: string, verdict: string): Inspection => ({
    page,
    checkedAt: 1,
    verdict,
    coverageState: null,
    lastCrawl: null,
    googleCanonical: null,
    userCanonical: null,
  });

  it("lists indexable pages that aren't PASS, never-inspected ones first", () => {
    const pages = [
      { id: "1", title: "Indexed", url: "https://h/indexed", index: true },
      { id: "2", title: "Unknown", url: "https://h/unknown", index: true },
      { id: "3", title: "Never", url: "https://h/never", index: true },
      { id: "4", title: "Noindex", url: "https://h/noindex", index: false },
    ];
    const latest = new Map([
      ["https://h/indexed", inspection("https://h/indexed", "PASS")],
      ["https://h/unknown", inspection("https://h/unknown", "NEUTRAL")],
      ["https://h/noindex", inspection("https://h/noindex", "NEUTRAL")],
    ]);
    expect(
      notIndexed(pages, latest, 0).map((p) => [
        p.pageId,
        p.inspection?.verdict ?? null,
      ])
    ).toEqual([
      ["3", null],
      ["2", "NEUTRAL"],
    ]);
  });

  it("a page first published under 3 days ago is pending, listed last; older ones and republished ones aren't", () => {
    const now = at("2026-10-02T00:00:00Z");
    const day = 24 * 60 * 60_000;
    const pages = [
      {
        id: "new",
        title: "New",
        url: "https://h/new",
        index: true,
        firstPublishedAt: now - 2 * day,
      },
      {
        id: "old",
        title: "Old",
        url: "https://h/old",
        index: true,
        firstPublishedAt: now - 3 * day,
      },
      {
        id: "unknown",
        title: "Unknown",
        url: "https://h/unknown",
        index: true,
        firstPublishedAt: null,
      },
    ];
    const latest = new Map([
      ["https://h/new", inspection("https://h/new", "NEUTRAL")],
    ]);
    expect(
      notIndexed(pages, latest, now).map((p) => [p.pageId, p.pending])
    ).toEqual([
      ["old", false],
      ["unknown", false],
      ["new", true],
    ]);
  });
});

describe("backfillWindows", () => {
  it("calendar months back from the end day, the last ending at it", () => {
    expect(backfillWindows("2026-10-02", 2)).toEqual([
      { start: "2026-08-02", end: "2026-08-31" },
      { start: "2026-09-01", end: "2026-09-30" },
      { start: "2026-10-01", end: "2026-10-02" },
    ]);
    const all = backfillWindows("2026-10-02", GSC_RETENTION_MONTHS);
    expect(all).toHaveLength(17);
    expect(all[0]!.start).toBe("2025-06-02");
    // Every window lies within one calendar month.
    for (const w of all) {
      expect(w.start.slice(0, 7)).toBe(w.end.slice(0, 7));
    }
  });
});

describe("pickInspectionTargets", () => {
  const now = at("2026-10-02T00:00:00Z");
  const day = 24 * 60 * 60_000;
  const pages = [
    { url: "fresh-checked", publishedAt: now - 10 * day },
    { url: "never-old", publishedAt: now - 30 * day },
    { url: "never-new", publishedAt: now - 1 * day },
    { url: "republished", publishedAt: now - 2 * day },
    { url: "stale-older", publishedAt: now - 90 * day },
    { url: "stale", publishedAt: now - 90 * day },
  ];
  const checked = new Map([
    ["fresh-checked", now - 3 * day],
    ["republished", now - 5 * day],
    ["stale-older", now - 20 * day],
    ["stale", now - REINSPECT_AFTER_MS],
  ]);

  it("orders never inspected (newest first), republished, then week-old inspections (oldest first); skips recent ones", () => {
    expect(pickInspectionTargets(pages, checked, now)).toEqual([
      "never-new",
      "never-old",
      "republished",
      "stale-older",
      "stale",
    ]);
  });

  it("caps the run", () => {
    expect(pickInspectionTargets(pages, checked, now, 2)).toEqual([
      "never-new",
      "never-old",
    ]);
  });
});
