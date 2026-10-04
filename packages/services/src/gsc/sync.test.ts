// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import {
  gscInspections,
  gscPageDays,
  gscRows,
  pages,
  revisions,
} from "@repo/db";
import { D1_MAX_PARAMS } from "@repo/db/shared";
import { createTestDb } from "@repo/db/test-utils";
import { type GscClient, GscError, type SearchAnalyticsRow } from "./client";

import { createD1GscStore } from "./d1";
import {
  inspectDuePages,
  inspectPages,
  recentWindow,
  syncSearchAnalytics,
} from "./sync";

const U = "https://example.com";
const config = { origin: U };

function fakeClient(
  rows: { query: SearchAnalyticsRow[]; page: SearchAnalyticsRow[] },
  inspect: (url: string) => Promise<Record<string, unknown>> = async () => ({
    verdict: "PASS",
  })
) {
  const calls: { dimensions: string[]; startDate: string; endDate: string }[] =
    [];
  const inspected: string[] = [];
  const client: GscClient = {
    async searchAnalytics(q) {
      calls.push(q);
      return q.dimensions.includes("query") ? rows.query : rows.page;
    },
    async inspectUrl(url) {
      inspected.push(url);
      return inspect(url);
    },
    async submitSitemap() {},
  };
  return { client, calls, inspected };
}

const qRow = (
  date: string,
  page: string,
  query: string,
  device = "MOBILE",
  impressions = 10,
  position = 5
): SearchAnalyticsRow => ({
  keys: [date, page, query, device],
  clicks: 1,
  impressions,
  ctr: 1 / impressions,
  position,
});
const pRow = (
  date: string,
  page: string,
  impressions = 10
): SearchAnalyticsRow => ({
  keys: [date, page],
  clicks: 2,
  impressions,
  ctr: 2 / impressions,
  position: 4.5,
});

describe("syncSearchAnalytics", () => {
  it("pulls query rows and page totals separately and writes both", async () => {
    const { db, log } = createTestDb();
    const fake = fakeClient({
      query: Array.from({ length: 30 }, (_, i) =>
        qRow("2026-09-05", `${U}/`, `query ${i}`)
      ),
      page: [
        pRow("2026-09-05", `${U}/`, 400),
        pRow("2026-09-06", `${U}/about`),
      ],
    });
    const summary = await syncSearchAnalytics(
      { store: createD1GscStore(db), client: fake.client },
      { start: "2026-09-01", end: "2026-09-10" }
    );
    expect(fake.calls.map((c) => c.dimensions)).toEqual([
      ["date", "page", "query", "device"],
      ["date", "page"],
    ]);
    expect(summary).toMatchObject({ rows: 30, pageDays: 2 });
    expect(await db.$count(gscRows)).toBe(30);
    expect(
      await db.select().from(gscPageDays).orderBy(gscPageDays.date)
    ).toEqual([
      {
        date: "2026-09-05",
        page: `${U}/`,
        clicks: 2,
        impressions: 400,
        ctr: 0.005,
        position: 4.5,
      },
      {
        date: "2026-09-06",
        page: `${U}/about`,
        clicks: 2,
        impressions: 10,
        ctr: 0.2,
        position: 4.5,
      },
    ]);
    expect(Math.max(...log.map((l) => l.params))).toBeLessThanOrEqual(
      D1_MAX_PARAMS
    );
  });

  it("replaces the window: revised values update, dropped rows go, rows outside stay", async () => {
    const { db } = createTestDb();
    await syncSearchAnalytics(
      {
        store: createD1GscStore(db),
        client: fakeClient({
          query: [
            qRow("2026-08-31", `${U}/`, "old"),
            qRow("2026-09-02", `${U}/`, "gone"),
            qRow("2026-09-03", `${U}/`, "kept", "MOBILE", 10),
          ],
          page: [pRow("2026-08-31", `${U}/`), pRow("2026-09-02", `${U}/`)],
        }).client,
      },
      { start: "2026-08-25", end: "2026-09-10" }
    );
    await syncSearchAnalytics(
      {
        store: createD1GscStore(db),
        client: fakeClient({
          query: [qRow("2026-09-03", `${U}/`, "kept", "MOBILE", 25)],
          page: [pRow("2026-09-03", `${U}/`, 25)],
        }).client,
      },
      { start: "2026-09-01", end: "2026-09-10" }
    );
    const rows = await db
      .select({
        date: gscRows.date,
        query: gscRows.query,
        impressions: gscRows.impressions,
      })
      .from(gscRows)
      .orderBy(gscRows.date);
    expect(rows).toEqual([
      { date: "2026-08-31", query: "old", impressions: 10 },
      { date: "2026-09-03", query: "kept", impressions: 25 },
    ]);
    expect(
      (
        await db
          .select({ date: gscPageDays.date })
          .from(gscPageDays)
          .orderBy(gscPageDays.date)
      ).map((r) => r.date)
    ).toEqual(["2026-08-31", "2026-09-03"]);
  });

  it("leaves D1 alone when Search Console returns nothing", async () => {
    const { db } = createTestDb();
    await syncSearchAnalytics(
      {
        store: createD1GscStore(db),
        client: fakeClient({
          query: [qRow("2026-09-03", `${U}/`, "q")],
          page: [pRow("2026-09-03", `${U}/`)],
        }).client,
      },
      { start: "2026-09-01", end: "2026-09-10" }
    );
    const summary = await syncSearchAnalytics(
      {
        store: createD1GscStore(db),
        client: fakeClient({ query: [], page: [] }).client,
      },
      { start: "2026-09-01", end: "2026-09-10" }
    );
    expect(summary.skipped).toBeTruthy();
    expect(await db.$count(gscRows)).toBe(1);
    expect(await db.$count(gscPageDays)).toBe(1);
  });

  it("re-pulls the last N days up to today's Pacific date", () => {
    expect(recentWindow(10, Date.parse("2026-10-02T03:00:00Z"))).toEqual({
      start: "2026-09-22",
      end: "2026-10-01",
    });
  });
});

describe("URL Inspection", () => {
  async function seedPublished(
    db: Awaited<ReturnType<typeof createTestDb>>["db"],
    slug: string,
    publishedAt: number,
    opts: { index?: boolean } = {}
  ) {
    const id = `p-${slug || "home"}`;
    const doc = {
      _schema: 1,
      seo:
        opts.index === undefined
          ? {}
          : { robots: { index: opts.index, follow: true } },
      blocks: [],
    } as never;
    await db.insert(pages).values({
      id,
      kind: "page",
      slug,
      title: slug,
      status: "published",
      draftDoc: doc,
      liveRevId: `r-${id}`,
      updatedAt: new Date(publishedAt),
    });
    await db.insert(revisions).values({
      id: `r-${id}`,
      pageId: id,
      docJson: doc,
      kind: "published",
      createdAt: new Date(publishedAt),
    });
  }

  it("stores each result with its verdict, coverage, crawl time and canonicals", async () => {
    const { db } = createTestDb();
    const fake = fakeClient({ query: [], page: [] }, async (url) => ({
      verdict: url.endsWith("/") ? "PASS" : "NEUTRAL",
      coverageState: url.endsWith("/")
        ? "Submitted and indexed"
        : "URL is unknown to Google",
      lastCrawlTime: "2026-09-30T10:00:00Z",
      googleCanonical: url,
      robotsTxtState: "ALLOWED",
    }));
    const summary = await inspectPages(
      {
        store: createD1GscStore(db),
        client: fake.client,
        clock: () => new Date(1000),
      },
      [`${U}/`, `${U}/new`]
    );
    expect(summary).toMatchObject({ inspected: 2, failed: [] });
    const rows = await db
      .select()
      .from(gscInspections)
      .orderBy(gscInspections.page);
    expect(rows[0]).toMatchObject({
      page: `${U}/`,
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      lastCrawl: "2026-09-30T10:00:00Z",
      googleCanonical: `${U}/`,
      checkedAt: new Date(1000),
    });
    expect(JSON.parse(rows[0]!.rawJson!)).toMatchObject({
      robotsTxtState: "ALLOWED",
    });
    expect(rows[1]).toMatchObject({
      verdict: "NEUTRAL",
      coverageState: "URL is unknown to Google",
    });
  });

  it("skips a URL Google rejects but stops on quota", async () => {
    const { db } = createTestDb();
    const fake = fakeClient({ query: [], page: [] }, async (url) => {
      if (url.endsWith("/bad")) {
        throw new GscError("BAD_REQUEST", "not in property", 400);
      }
      if (url.endsWith("/quota")) {
        throw new GscError("RATE_LIMITED", "quota", 429);
      }
      return { verdict: "PASS" };
    });
    const summary = await inspectPages(
      { store: createD1GscStore(db), client: fake.client, log: () => {} },
      [`${U}/bad`, `${U}/ok`, `${U}/quota`, `${U}/never`]
    );
    expect(summary).toEqual({
      candidates: 4,
      inspected: 1,
      failed: [{ url: `${U}/bad`, code: "BAD_REQUEST" }],
      stopped: "RATE_LIMITED",
    });
    expect(fake.inspected).not.toContain(`${U}/never`);
  });

  it("inspects the published pages that are due, and not again until they are", async () => {
    const { db } = createTestDb();
    const day = 24 * 60 * 60_000;
    let now = Date.parse("2026-10-02T00:00:00Z");
    await seedPublished(db, "", now - 30 * day);
    await seedPublished(db, "services/new", now - day);
    await db.insert(pages).values({
      id: "draft",
      kind: "page",
      slug: "draft-only",
      title: "d",
      status: "draft",
      updatedAt: new Date(now),
    });
    // Live but noindex: Google is told not to index it, so it isn't inspected.
    await seedPublished(db, "hidden", now - 2 * day, { index: false });
    await seedPublished(db, "indexed", now - 40 * day, { index: true });
    const fake = fakeClient({ query: [], page: [] });
    const first = await inspectDuePages({
      store: createD1GscStore(db),
      client: fake.client,
      clock: () => new Date(now),
      config,
    });
    expect(fake.inspected).toEqual([
      `${U}/services/new`,
      `${U}/`,
      `${U}/indexed`,
    ]);
    expect(first.inspected).toBe(3);
    now += day;
    expect(
      (
        await inspectDuePages({
          store: createD1GscStore(db),
          client: fake.client,
          clock: () => new Date(now),
          config,
        })
      ).candidates
    ).toBe(0);
    now += 7 * day;
    await inspectDuePages({
      store: createD1GscStore(db),
      client: fake.client,
      clock: () => new Date(now),
      config,
    });
    expect(fake.inspected).toHaveLength(6);
    expect(fake.inspected).not.toContain(`${U}/hidden`);
  });
});
