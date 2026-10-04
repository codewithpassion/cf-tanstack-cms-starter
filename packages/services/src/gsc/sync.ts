// biome-ignore-all lint/performance/noAwaitInLoops: URL Inspection runs one URL at a time on purpose (quota, and a quota error stops the run).
import {
  gscDayOf,
  INSPECT_PER_RUN,
  pageUrl,
  pickInspectionTargets,
  windowEndingAt,
} from "@repo/cms-core/gsc/shape";
import type { SiteConfig } from "@repo/cms-core/site/config";
import type {
  insertInspection,
  PageDayInsert,
  PageUrl,
  RowInsert,
} from "@repo/db/gsc";

import { type Clock, systemClock } from "../clock";
import {
  type GscClient,
  GscError,
  type GscErrorCode,
  type IndexStatusResult,
  type SearchAnalyticsRow,
} from "./client";

/**
 * Search Console → D1. Used by the daily cron (cron.ts), the setup backfill and the Bun scripts
 * (gsc:backfill, gsc:sync); takes the storage and client as ports, so it runs under `bun test`.
 */

/** A `gsc_inspections` row as `insertInspection` (`@repo/db/gsc`) takes it. */
export type InspectionInsert = Parameters<typeof insertInspection>[1];

/**
 * The storage the sync needs: `@repo/db/gsc`'s `replaceWindow`, `publishedPages`,
 * `lastInspections` and `insertInspection` with the database bound, e.g.
 * `replaceWindow: (...a) => replaceWindow(db, ...a)`.
 */
export type GscStore = {
  /** Replaces `start`..`end` in `gsc_rows` and `gsc_page_days` in one transaction; returns how many statements ran. */
  replaceWindow: (
    start: string,
    end: string,
    rows: RowInsert[],
    pageDays: PageDayInsert[]
  ) => Promise<number>;
  /** Published, indexable pages with their URL and when their live revision was published. */
  publishedPages: (
    pageUrl: PageUrl
  ) => Promise<{ url: string; publishedAt: number }[]>;
  /** When each URL was last inspected (epoch ms), by URL. */
  lastInspections: () => Promise<Map<string, number>>;
  insertInspection: (row: InspectionInsert) => Promise<void>;
};

export type GscDeps = {
  store: GscStore;
  client: GscClient;
  clock?: Clock;
  log?: (message: string) => void;
};

/** The row's dimension keys, in the order they were requested (Google always sends them all). */
const key = (r: SearchAnalyticsRow, i: number) => r.keys[i] ?? "";

const toRow = (r: SearchAnalyticsRow): RowInsert => ({
  date: key(r, 0),
  page: key(r, 1),
  query: key(r, 2),
  device: key(r, 3),
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: r.ctr,
  position: r.position,
});

const toPageDay = (r: SearchAnalyticsRow): PageDayInsert => ({
  date: key(r, 0),
  page: key(r, 1),
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: r.ctr,
  position: r.position,
});

export type SyncSummary = {
  start: string;
  end: string;
  rows: number;
  pageDays: number;
  statements: number;
  skipped?: string;
};

/**
 * Pulls `start`..`end` (YYYY-MM-DD, inclusive) twice — date × page × query × device into
 * `gsc_rows`, date × page totals into `gsc_page_days` (anonymised queries are missing from the
 * first, so it never adds up to the second) — and replaces that window in D1.
 * An empty response leaves D1 alone rather than wiping the window.
 */
export async function syncSearchAnalytics(
  { store, client }: Pick<GscDeps, "store" | "client">,
  { start, end, rowLimit }: { start: string; end: string; rowLimit?: number }
): Promise<SyncSummary> {
  const [queryRows, pageRows] = await Promise.all([
    client.searchAnalytics({
      startDate: start,
      endDate: end,
      dimensions: ["date", "page", "query", "device"],
      rowLimit,
    }),
    client.searchAnalytics({
      startDate: start,
      endDate: end,
      dimensions: ["date", "page"],
      rowLimit,
    }),
  ]);
  if (!pageRows.length) {
    return {
      start,
      end,
      rows: 0,
      pageDays: 0,
      statements: 0,
      skipped: "Search Console returned no rows",
    };
  }
  const statements = await store.replaceWindow(
    start,
    end,
    queryRows.map(toRow),
    pageRows.map(toPageDay)
  );
  return {
    start,
    end,
    rows: queryRows.length,
    pageDays: pageRows.length,
    statements,
  };
}

/**
 * The last `days` days up to today: the cron's re-pull window. "Today" is Search Console's own
 * day (Pacific time, `gscDayOf`), the calendar its data is reported in, not the site's time zone.
 */
export function recentWindow(
  days: number,
  now: number
): { start: string; end: string } {
  return windowEndingAt(gscDayOf(now), days);
}

// ---------------------------------------------------------------------------------------------
// URL Inspection

export type InspectSummary = {
  candidates: number;
  inspected: number;
  failed: { url: string; code: GscErrorCode }[];
  stopped?: GscErrorCode;
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * URL Inspection for the given URLs, one at a time, each result stored in `gsc_inspections`.
 * Quota or sign-in failures stop the run; a failure for one URL is recorded and skipped.
 */
export async function inspectPages(
  { store, client, clock = systemClock, log = () => undefined }: GscDeps,
  urls: string[]
): Promise<InspectSummary> {
  const summary: InspectSummary = {
    candidates: urls.length,
    inspected: 0,
    failed: [],
  };
  for (const url of urls) {
    let result: IndexStatusResult;
    try {
      result = await client.inspectUrl(url);
    } catch (err) {
      if (!(err instanceof GscError)) {
        throw err;
      }
      if (
        err.code === "AUTH" ||
        err.code === "RATE_LIMITED" ||
        err.code === "FORBIDDEN"
      ) {
        summary.stopped = err.code;
        log(`gsc inspect: stopped at ${url}: ${err.message}`);
        return summary;
      }
      summary.failed.push({ url, code: err.code });
      log(`gsc inspect: ${url} failed: ${err.message}`);
      continue;
    }
    await store.insertInspection({
      page: url,
      checkedAt: clock(),
      verdict:
        typeof result.verdict === "string"
          ? result.verdict
          : "VERDICT_UNSPECIFIED",
      coverageState: str(result.coverageState),
      lastCrawl: str(result.lastCrawlTime),
      googleCanonical: str(result.googleCanonical),
      userCanonical: str(result.userCanonical),
      rawJson: JSON.stringify(result),
    });
    summary.inspected += 1;
  }
  return summary;
}

/**
 * Inspects the published pages that are due (see `pickInspectionTargets`), at most `cap`. Page
 * URLs are built on `config.origin`.
 */
export async function inspectDuePages(
  deps: GscDeps & { config: Pick<SiteConfig, "origin"> },
  cap = INSPECT_PER_RUN
): Promise<InspectSummary> {
  const clock = deps.clock ?? systemClock;
  const urlOf: PageUrl = (slug) => pageUrl(slug, deps.config);
  const [published, checked] = await Promise.all([
    deps.store.publishedPages(urlOf),
    deps.store.lastInspections(),
  ]);
  return inspectPages(
    deps,
    pickInspectionTargets(published, checked, clock().getTime(), cap)
  );
}
