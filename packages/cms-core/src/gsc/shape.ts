import type { SiteConfig } from "../site/config";

/**
 * Search Console shaping shared by the server (src/modules/cms/server/gsc-*.ts) and the admin UI
 *: page URLs, totals, the daily series with publish markers, striking-
 * distance grouping and inspection target picking. Pure and dependency-free, so the editor's lazy
 * performance chunk and /admin/seo can import it.
 */

/** How to connect Search Console here: shown wherever its data or actions are missing. */
export const GSC_CONNECT_HINT =
  "Search Console not connected: run `bun scripts/gsc-auth.ts` in apps/web, then set GSC_REFRESH_TOKEN (see .env.example).";

/** The URL Search Console uses for a page slug ("" is the home page, reported as `https://host/`). The origin is `SiteConfig.origin`. */
export function pageUrl(
  slug: string,
  config: Pick<SiteConfig, "origin">
): string {
  return `${config.origin}/${slug}`;
}

export type GscMetrics = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
};

export type GscDay = { date: string } & GscMetrics;

/** Sums used to build `GscMetrics`: `positionWeight` is Σ(position × impressions). */
export type MetricSums = {
  clicks: number;
  impressions: number;
  positionWeight: number;
};

/** CTR = clicks / impressions; position is impression-weighted (as the GSC UI averages it). */
export function metricsFromSums({
  clicks,
  impressions,
  positionWeight,
}: MetricSums): GscMetrics {
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? positionWeight / impressions : null,
  };
}

export function totalsOf(days: GscDay[]): GscMetrics {
  return metricsFromSums(
    days.reduce(
      (s, d) => ({
        clicks: s.clicks + d.clicks,
        impressions: s.impressions + d.impressions,
        positionWeight: s.positionWeight + (d.position ?? 0) * d.impressions,
      }),
      { clicks: 0, impressions: 0, positionWeight: 0 }
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Dates (YYYY-MM-DD strings; Search Console days are Pacific time)

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every date from `start` to `end`, inclusive. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(d);
  }
  return out;
}

const pacificDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Search Console day (Pacific time) a moment falls on, as YYYY-MM-DD. Built from the parts,
 * not from a locale's formatted string, so it doesn't depend on how a runtime formats en-CA dates.
 */
export function gscDayOf(ms: number): string {
  const parts = Object.fromEntries(
    pacificDay.formatToParts(new Date(ms)).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Search Console keeps 16 months of data. */
export const GSC_RETENTION_MONTHS = 16;

/**
 * The backfill's windows: calendar months from `months` months before `end` up to `end`
 * (inclusive), the first starting mid-month and the last ending at `end`. One API pull and one D1
 * batch each, so every step stays small (scripts/gsc-backfill.ts, /admin/setup).
 */
export function backfillWindows(
  end: string,
  months: number
): { start: string; end: string }[] {
  const first = new Date(`${end}T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() - months);
  const windows: { start: string; end: string }[] = [];
  for (let start = first.toISOString().slice(0, 10); start <= end; ) {
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    const monthEnd = addDays(next.toISOString().slice(0, 10), -1);
    windows.push({ start, end: monthEnd < end ? monthEnd : end });
    start = next.toISOString().slice(0, 10);
  }
  return windows;
}

/** The last `days` days ending at `end` (inclusive). */
export function windowEndingAt(
  end: string,
  days: number
): { start: string; end: string } {
  return { start: addDays(end, -(days - 1)), end };
}

/** Days with no row in Search Console had no impressions: fill them with zeros so the chart has every day. */
export function fillSeries(
  days: GscDay[],
  start: string,
  end: string
): GscDay[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  return dateRange(start, end).map(
    (date) =>
      byDate.get(date) ?? {
        date,
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: null,
      }
  );
}

// ---------------------------------------------------------------------------------------------
// Publish markers

export type PublishMarker = {
  date: string;
  count: number;
  revIds: string[];
  labels: string[];
};

/**
 * Published revisions as chart markers: one per Search Console day (several publishes on a day
 * merge), only inside `start`..`end`, in date order.
 */
export function publishMarkers(
  revisions: { id: string; createdAt: number; label: string | null }[],
  start: string,
  end: string
): PublishMarker[] {
  const byDay = new Map<string, PublishMarker>();
  for (const r of [...revisions].sort((a, b) => a.createdAt - b.createdAt)) {
    const date = gscDayOf(r.createdAt);
    if (date < start || date > end) {
      continue;
    }
    const m = byDay.get(date) ?? { date, count: 0, revIds: [], labels: [] };
    m.count += 1;
    m.revIds.push(r.id);
    if (r.label) {
      m.labels.push(r.label);
    }
    byDay.set(date, m);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Opportunities

/** A query aggregated over the window (all days and devices). */
export type QueryRow = {
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
};

export type StrikingPage = {
  page: string;
  /** The CMS page at this URL, when there is one. */
  pageId: string | null;
  impressions: number;
  queries: QueryRow[];
};

export const STRIKING_MIN_POSITION = 4;
export const STRIKING_MAX_POSITION = 20;

/**
 * Striking distance: queries ranking 4–20 with at least `minImpressions`, grouped by page. Pages
 * are ordered by the impressions those queries bring, queries by impressions. The SQL already
 * filters; this re-applies the rule so the shape never depends on the query.
 */
export function groupStriking(
  rows: QueryRow[],
  minImpressions: number,
  pageIds: Map<string, string>
): StrikingPage[] {
  const pages = new Map<string, StrikingPage>();
  for (const r of rows) {
    if (
      r.impressions < minImpressions ||
      r.position < STRIKING_MIN_POSITION ||
      r.position > STRIKING_MAX_POSITION
    ) {
      continue;
    }
    const p = pages.get(r.page) ?? {
      page: r.page,
      pageId: pageIds.get(r.page) ?? null,
      impressions: 0,
      queries: [],
    };
    p.impressions += r.impressions;
    p.queries.push(r);
    pages.set(r.page, p);
  }
  for (const p of pages.values()) {
    p.queries.sort(
      (a, b) => b.impressions - a.impressions || a.position - b.position
    );
  }
  return [...pages.values()].sort(
    (a, b) => b.impressions - a.impressions || (a.page < b.page ? -1 : 1)
  );
}

export type Inspection = {
  page: string;
  checkedAt: number;
  verdict: string;
  coverageState: string | null;
  lastCrawl: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
};

/**
 * `pending`: first published less than `PENDING_INDEX_MS` ago, so Google most likely hasn't got to
 * it yet; shown as "pending", not as a problem.
 */
export type NotIndexedPage = {
  pageId: string;
  title: string;
  url: string;
  inspection: Inspection | null;
  pending: boolean;
};

/** How long a newly published page counts as "pending" rather than "not indexed". */
export const PENDING_INDEX_MS = 3 * 24 * 60 * 60_000;

/**
 * Published, indexable CMS pages whose latest inspection isn't PASS (or that were never inspected):
 * the problems first (never inspected, then the rest), the pending ones (first published within
 * the last 3 days) last.
 */
export function notIndexed(
  pages: {
    id: string;
    title: string;
    url: string;
    index: boolean;
    firstPublishedAt?: number | null;
  }[],
  latest: Map<string, Inspection>,
  now: number
): NotIndexedPage[] {
  const rank = (p: NotIndexedPage) => {
    if (p.pending) {
      return 2;
    }
    return p.inspection ? 1 : 0;
  };
  return pages
    .filter((p) => p.index && latest.get(p.url)?.verdict !== "PASS")
    .map((p) => ({
      pageId: p.id,
      title: p.title,
      url: p.url,
      inspection: latest.get(p.url) ?? null,
      pending:
        p.firstPublishedAt !== null &&
        p.firstPublishedAt !== undefined &&
        now - p.firstPublishedAt < PENDING_INDEX_MS,
    }))
    .sort((a, b) => rank(a) - rank(b) || (a.url < b.url ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Inspection scheduling

export const INSPECT_PER_RUN = 50;
export const REINSPECT_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * Which published pages to inspect this run, at most `cap`: never inspected first (most recently
 * published first), then pages published again since their last inspection, then inspections
 * older than a week (oldest first). Everything else waits.
 */
export function pickInspectionTargets(
  pages: { url: string; publishedAt: number }[],
  lastChecked: Map<string, number>,
  now: number,
  cap = INSPECT_PER_RUN
): string[] {
  const rank = (p: {
    url: string;
    publishedAt: number;
  }): [number, number] | null => {
    const checked = lastChecked.get(p.url);
    if (checked === undefined) {
      return [0, -p.publishedAt];
    }
    if (p.publishedAt > checked) {
      return [1, -p.publishedAt];
    }
    if (now - checked >= REINSPECT_AFTER_MS) {
      return [2, checked];
    }
    return null;
  };
  return pages
    .flatMap((p) => {
      const r = rank(p);
      return r ? [{ url: p.url, r }] : [];
    })
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1])
    .slice(0, cap)
    .map((t) => t.url);
}

// ---------------------------------------------------------------------------------------------
// Server function results

export type PagePerformance = {
  url: string;
  days: number;
  /** null when there is no Search Console data in D1 yet. */
  range: { start: string; end: string } | null;
  totals: GscMetrics;
  series: GscDay[];
  /**
   * The chart's last day: today (Pacific) when that's after `range.end`. The days in between have
   * no final data yet, but publishes on them still get markers.
   */
  chartEnd: string | null;
  markers: PublishMarker[];
  topQueries: QueryRow[];
  inspection: Inspection | null;
};

export type SeoGscOverview = {
  range: { start: string; end: string } | null;
  /** 28-day totals per CMS page id. */
  byPageId: Record<string, GscMetrics>;
  striking: StrikingPage[];
  minImpressions: number;
  notIndexed: NotIndexedPage[];
};
