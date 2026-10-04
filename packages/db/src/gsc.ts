// biome-ignore-all lint/performance/noAwaitInLoops: inspection reads go in sequential chunks to stay under D1's parameter limit.

import {
  fillSeries,
  type GscMetrics,
  groupStriking,
  gscDayOf,
  type Inspection,
  metricsFromSums,
  notIndexed,
  type PagePerformance,
  publishMarkers,
  type QueryRow,
  type SeoGscOverview,
  STRIKING_MAX_POSITION,
  STRIKING_MIN_POSITION,
  windowEndingAt,
} from "@repo/cms-core/gsc/shape";
import {
  and,
  between,
  desc,
  eq,
  gte,
  inArray,
  lte,
  max,
  ne,
  sql,
} from "drizzle-orm";

import {
  type D1Db,
  gscInspections,
  gscPageDays,
  gscRows,
  pages,
  revisionLabels,
  revisions,
} from "./schema.ts";
import { D1_MAX_PARAMS } from "./shared.ts";

type GscDb = D1Db;

/**
 * The public URL Google reports for a page slug. The origin is the site's (`SITE_ORIGIN`), which
 * only the caller knows, so every query that matches pages to Search Console rows takes this.
 */
export type PageUrl = (slug: string) => string;

/**
 * Search Console reads for the SEO tab and /admin/seo, all from D1. Every
 * window ends at the newest day in `gsc_page_days` (data lags 2–3 days), not today, so "28 days"
 * means 28 days of data, as in the GSC UI.
 */

/** Impression-weighted sums for `metricsFromSums`. */
const sums = <T extends typeof gscPageDays | typeof gscRows>(t: T) => ({
  clicks: sql<number>`sum(${t.clicks})`.mapWith(Number),
  impressions: sql<number>`sum(${t.impressions})`.mapWith(Number),
  positionWeight: sql<number>`sum(${t.position} * ${t.impressions})`.mapWith(
    Number
  ),
});

export async function latestGscDate(db: GscDb): Promise<string | null> {
  const [row] = await db
    .select({ date: max(gscPageDays.date) })
    .from(gscPageDays);
  return row?.date ?? null;
}

async function latestInspection(
  db: GscDb,
  url: string
): Promise<Inspection | null> {
  const [row] = await db
    .select({
      page: gscInspections.page,
      checkedAt: gscInspections.checkedAt,
      verdict: gscInspections.verdict,
      coverageState: gscInspections.coverageState,
      lastCrawl: gscInspections.lastCrawl,
      googleCanonical: gscInspections.googleCanonical,
      userCanonical: gscInspections.userCanonical,
    })
    .from(gscInspections)
    .where(eq(gscInspections.page, url))
    .orderBy(desc(gscInspections.checkedAt))
    .limit(1);
  return row ? { ...row, checkedAt: row.checkedAt.getTime() } : null;
}

export const TOP_QUERIES = 10;

/** The SEO tab's numbers for one page: totals, daily series, publish markers, top queries, index status. */
export async function pagePerformance(
  db: GscDb,
  page: { id: string; slug: string },
  days: number,
  { pageUrl, now = Date.now() }: { pageUrl: PageUrl; now?: number }
): Promise<PagePerformance> {
  const url = pageUrl(page.slug);
  const [latest, inspection, published] = await Promise.all([
    latestGscDate(db),
    latestInspection(db, url),
    db
      // The display label: a rename (revision_labels) wins over the label it was saved with.
      .select({
        id: revisions.id,
        createdAt: revisions.createdAt,
        label: sql<
          string | null
        >`coalesce(${revisionLabels.label}, ${revisions.label})`,
      })
      .from(revisions)
      .leftJoin(revisionLabels, eq(revisionLabels.revId, revisions.id))
      .where(
        and(eq(revisions.pageId, page.id), eq(revisions.kind, "published"))
      ),
  ]);
  if (!latest) {
    return {
      url,
      days,
      range: null,
      totals: metricsFromSums({ clicks: 0, impressions: 0, positionWeight: 0 }),
      series: [],
      chartEnd: null,
      markers: [],
      topQueries: [],
      inspection,
    };
  }

  const range = windowEndingAt(latest, days);
  const [dayRows, queryRows] = await Promise.all([
    db
      .select({
        date: gscPageDays.date,
        clicks: gscPageDays.clicks,
        impressions: gscPageDays.impressions,
        ctr: gscPageDays.ctr,
        position: gscPageDays.position,
      })
      .from(gscPageDays)
      .where(
        and(
          eq(gscPageDays.page, url),
          between(gscPageDays.date, range.start, range.end)
        )
      ),
    topQueries(db, url, range),
  ]);
  const series = fillSeries(dayRows, range.start, range.end);
  const totals = metricsFromSums({
    clicks: dayRows.reduce((s, d) => s + d.clicks, 0),
    impressions: dayRows.reduce((s, d) => s + d.impressions, 0),
    positionWeight: dayRows.reduce((s, d) => s + d.position * d.impressions, 0),
  });
  const today = gscDayOf(now);
  const chartEnd = today > range.end ? today : range.end;
  const markers = publishMarkers(
    published.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.getTime(),
      label: r.label,
    })),
    range.start,
    chartEnd
  );
  return {
    url,
    days,
    range,
    totals,
    series,
    chartEnd,
    markers,
    topQueries: queryRows,
    inspection,
  };
}

/** A page's queries over the window, summed across days and devices; by clicks, then impressions. */
async function topQueries(
  db: GscDb,
  url: string,
  range: { start: string; end: string }
): Promise<QueryRow[]> {
  const s = sums(gscRows);
  const rows = await db
    .select({ query: gscRows.query, ...s })
    .from(gscRows)
    .where(
      and(eq(gscRows.page, url), between(gscRows.date, range.start, range.end))
    )
    .groupBy(gscRows.query)
    .orderBy(desc(s.clicks), desc(s.impressions), gscRows.query)
    .limit(TOP_QUERIES);
  return rows.map((r) => {
    const m = metricsFromSums(r);
    return {
      page: url,
      query: r.query,
      clicks: m.clicks,
      impressions: m.impressions,
      position: m.position ?? 0,
    };
  });
}

export const OVERVIEW_DAYS = 28;
export const DEFAULT_MIN_IMPRESSIONS = 10;

/**
 * Striking-distance candidates in SQL: each (page, query) aggregated over the window first (all
 * days and devices, impression-weighted position), then filtered, so a query that ranks 3 on one
 * day and 30 on another is judged on its average.
 */
export function strikingRows(
  db: GscDb,
  range: { start: string; end: string },
  minImpressions: number,
  limit = 500
): Promise<QueryRow[]> {
  const s = sums(gscRows);
  const position =
    sql<number>`sum(${gscRows.position} * ${gscRows.impressions}) / sum(${gscRows.impressions})`.mapWith(
      Number
    );
  return db
    .select({
      page: gscRows.page,
      query: gscRows.query,
      clicks: s.clicks,
      impressions: s.impressions,
      position,
    })
    .from(gscRows)
    .where(between(gscRows.date, range.start, range.end))
    .groupBy(gscRows.page, gscRows.query)
    .having(
      sql`sum(${gscRows.impressions}) >= ${minImpressions} and ${position} between ${STRIKING_MIN_POSITION} and ${STRIKING_MAX_POSITION}`
    )
    .orderBy(desc(s.impressions))
    .limit(limit);
}

/** /admin/seo's Search Console columns and Opportunities (striking distance, not indexed). */
export async function seoGscOverview(
  db: GscDb,
  {
    pageUrl,
    minImpressions = DEFAULT_MIN_IMPRESSIONS,
    now = Date.now(),
  }: { pageUrl: PageUrl; minImpressions?: number; now?: number }
): Promise<SeoGscOverview> {
  const [latest, cmsPages] = await Promise.all([
    latestGscDate(db),
    db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        status: pages.status,
        // The live document's robots.index: pages kept out of search on purpose aren't "not indexed".
        liveIndex: sql<
          number | boolean | null
        >`json_extract(${revisions.docJson}, '$.seo.robots.index')`,
        // When the page was first published (a new page isn't expected in Google for a few days).
        firstPublishedAt: sql<
          number | null
        >`(select min(r.created_at) from ${revisions} r where r.page_id = ${pages.id} and r.kind = 'published')`,
      })
      .from(pages)
      .leftJoin(revisions, eq(revisions.id, pages.liveRevId))
      .where(ne(pages.status, "archived")),
  ]);
  const idByUrl = new Map(cmsPages.map((p) => [pageUrl(p.slug), p.id]));
  const published = cmsPages
    .filter((p) => p.status === "published")
    .map((p) => ({
      id: p.id,
      title: p.title,
      url: pageUrl(p.slug),
      index: p.liveIndex !== 0 && p.liveIndex !== false,
      firstPublishedAt:
        p.firstPublishedAt === null ? null : Number(p.firstPublishedAt),
    }));

  const inspections = await latestInspections(
    db,
    published.map((p) => p.url)
  );
  const notIndexedPages = notIndexed(published, inspections, now);
  if (!latest) {
    return {
      range: null,
      byPageId: {},
      striking: [],
      minImpressions,
      notIndexed: notIndexedPages,
    };
  }

  const range = windowEndingAt(latest, OVERVIEW_DAYS);
  const s = sums(gscPageDays);
  const [totals, striking] = await Promise.all([
    db
      .select({ page: gscPageDays.page, ...s })
      .from(gscPageDays)
      .where(between(gscPageDays.date, range.start, range.end))
      .groupBy(gscPageDays.page),
    strikingRows(db, range, minImpressions),
  ]);
  const byPageId: Record<string, GscMetrics> = {};
  for (const t of totals) {
    const id = idByUrl.get(t.page);
    if (id) {
      byPageId[id] = metricsFromSums(t);
    }
  }
  return {
    range,
    byPageId,
    striking: groupStriking(striking, minImpressions, idByUrl),
    minImpressions,
    notIndexed: notIndexedPages,
  };
}

/** D1 binds at most 100 parameters per query; `inArray` binds one per URL. */
const IN_CHUNK = D1_MAX_PARAMS - 10;

/** The newest inspection of each URL: only those rows are read (the latest `checked_at` per page, joined back), not the history. */
async function latestInspections(
  db: GscDb,
  urls: string[]
): Promise<Map<string, Inspection>> {
  const latest = new Map<string, Inspection>();
  for (let i = 0; i < urls.length; i += IN_CHUNK) {
    const newest = db
      .select({
        page: gscInspections.page,
        checkedAt: max(gscInspections.checkedAt).as("newest_checked_at"),
      })
      .from(gscInspections)
      .where(inArray(gscInspections.page, urls.slice(i, i + IN_CHUNK)))
      .groupBy(gscInspections.page)
      .as("newest");
    const rows = await db
      .select({
        page: gscInspections.page,
        checkedAt: gscInspections.checkedAt,
        verdict: gscInspections.verdict,
        coverageState: gscInspections.coverageState,
        lastCrawl: gscInspections.lastCrawl,
        googleCanonical: gscInspections.googleCanonical,
        userCanonical: gscInspections.userCanonical,
      })
      .from(gscInspections)
      .innerJoin(
        newest,
        and(
          eq(gscInspections.page, newest.page),
          eq(gscInspections.checkedAt, newest.checkedAt)
        )
      );
    // Two inspections of a page in the same millisecond would both match; keep one.
    for (const r of rows) {
      if (!latest.has(r.page)) {
        latest.set(r.page, { ...r, checkedAt: r.checkedAt.getTime() });
      }
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// Storage: what the sync (daily cron, setup backfill, scripts) writes and reads. The orchestration
// (calling Search Console, picking URLs) lives in `@repo/services`.

type RowInsert = typeof gscRows.$inferInsert;
type PageDayInsert = typeof gscPageDays.$inferInsert;

export type { PageDayInsert, RowInsert };

const ROW_COLUMNS = 8;
const PAGE_DAY_COLUMNS = 6;
export const ROWS_PER_INSERT = Math.floor(D1_MAX_PARAMS / ROW_COLUMNS);
export const PAGE_DAYS_PER_INSERT = Math.floor(
  D1_MAX_PARAMS / PAGE_DAY_COLUMNS
);

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** `excluded.<column>`: the value the conflicting insert carried. */
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

/**
 * The statements that replace `start`..`end` in both tables: delete the window, then insert in
 * chunks that stay under D1's parameter limit. Run as one `db.batch` (a transaction), so a
 * re-pulled window never mixes old and new rows, and rows Google dropped on revision go away.
 * Upserts rather than plain inserts, so a duplicate key in Google's response can't fail the batch.
 */
export function replaceWindowStatements(
  db: GscDb,
  start: string,
  end: string,
  rows: RowInsert[],
  pageDays: PageDayInsert[]
) {
  return [
    db
      .delete(gscRows)
      .where(and(gte(gscRows.date, start), lte(gscRows.date, end))),
    db
      .delete(gscPageDays)
      .where(and(gte(gscPageDays.date, start), lte(gscPageDays.date, end))),
    ...chunk(rows, ROWS_PER_INSERT).map((values) =>
      db
        .insert(gscRows)
        .values(values)
        .onConflictDoUpdate({
          target: [gscRows.date, gscRows.page, gscRows.query, gscRows.device],
          set: {
            clicks: sqlExcluded("clicks"),
            impressions: sqlExcluded("impressions"),
            ctr: sqlExcluded("ctr"),
            position: sqlExcluded("position"),
          },
        })
    ),
    ...chunk(pageDays, PAGE_DAYS_PER_INSERT).map((values) =>
      db
        .insert(gscPageDays)
        .values(values)
        .onConflictDoUpdate({
          target: [gscPageDays.date, gscPageDays.page],
          set: {
            clicks: sqlExcluded("clicks"),
            impressions: sqlExcluded("impressions"),
            ctr: sqlExcluded("ctr"),
            position: sqlExcluded("position"),
          },
        })
    ),
  ] as const;
}

/** Replaces `start`..`end` in `gsc_rows` and `gsc_page_days` in one transaction. Returns how many statements ran. */
export async function replaceWindow(
  db: GscDb,
  start: string,
  end: string,
  rows: RowInsert[],
  pageDays: PageDayInsert[]
): Promise<number> {
  const statements = replaceWindowStatements(db, start, end, rows, pageDays);
  await db.batch(statements);
  return statements.length;
}

/**
 * Published CMS pages with their URL and when their live revision was published. Pages whose live
 * version is noindex are left out: Google is told not to index them, so inspecting them only
 * spends quota.
 */
export async function publishedPages(
  db: GscDb,
  pageUrl: PageUrl
): Promise<{ url: string; publishedAt: number }[]> {
  const rows = await db
    .select({ slug: pages.slug, publishedAt: revisions.createdAt })
    .from(pages)
    .innerJoin(revisions, eq(revisions.id, pages.liveRevId))
    // JSON false reads as 0 in SQLite; a missing value counts as indexable.
    .where(
      and(
        eq(pages.status, "published"),
        sql`coalesce(json_extract(${revisions.docJson}, '$.seo.robots.index'), 1) != 0`
      )
    );
  return rows.map((r) => ({
    url: pageUrl(r.slug),
    publishedAt: r.publishedAt.getTime(),
  }));
}

/** When each URL was last inspected (epoch ms), by URL. */
export async function lastInspections(db: GscDb): Promise<Map<string, number>> {
  const rows = await db
    .select({
      page: gscInspections.page,
      checkedAt: max(gscInspections.checkedAt),
    })
    .from(gscInspections)
    .groupBy(gscInspections.page);
  return new Map(
    rows.flatMap((r) =>
      r.checkedAt ? [[r.page, r.checkedAt.getTime()] as const] : []
    )
  );
}

/** Stores one URL Inspection result. */
export async function insertInspection(
  db: GscDb,
  row: typeof gscInspections.$inferInsert
): Promise<void> {
  await db.insert(gscInspections).values(row);
}
