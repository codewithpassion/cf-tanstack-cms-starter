// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
import type { GscMetrics } from "../gsc/shape";
import type { PageKind } from "../types";
import type { CheckStatus } from "./checks";

/**
 * Rows of the /admin/seo table and their sorting and filtering. Built on
 * the server (overview.ts); this module stays free of the checks and the block registry so the
 * route chunk only carries the table.
 */

export type SeoOverviewIssue = {
  id: string;
  label: string;
  status: Exclude<CheckStatus, "pass" | "info" | "na">;
  message: string;
};

export type SeoOverviewRow = {
  id: string;
  kind: PageKind;
  slug: string;
  path: string;
  /** The page's name in the CMS. */
  pageTitle: string;
  status: "draft" | "published";
  /** The `<title>` (template applied). */
  seoTitle: string;
  description: string;
  index: boolean;
  sitemap: boolean;
  shareImage: {
    src: string;
    isDefault: boolean;
    width: number | null;
    height: number | null;
  };
  score: number;
  fails: number;
  warns: number;
  duplicateTitle: boolean;
  duplicateDescription: boolean;
  /** Failures first, then warnings. */
  issues: SeoOverviewIssue[];
  /** Search Console totals over the last 28 days (merged in by /admin/seo; null: no impressions). */
  gsc?: GscMetrics | null;
};

export const SEO_SORT_KEYS = [
  "pageTitle",
  "path",
  "kind",
  "status",
  "seoTitle",
  "description",
  "index",
  "score",
  "issues",
  "clicks",
  "impressions",
  "position",
] as const;
export type SeoSortKey = (typeof SEO_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

/** null: no Search Console data for the row, which sorts last in either direction. */
function sortValue(
  row: SeoOverviewRow,
  key: SeoSortKey
): string | number | null {
  switch (key) {
    case "index":
      return row.index ? 1 : 0;
    case "score":
      return row.score;
    case "issues":
      // Failures weigh more than any number of warnings.
      return row.fails * 1000 + row.warns;
    case "clicks":
    case "impressions":
      return row.gsc?.[key] ?? null;
    case "position":
      // No position (no impressions) sorts after every real one.
      return row.gsc?.position ?? null;
    default:
      return row[key].toLowerCase();
  }
}

/** A sorted copy; rows without a value go last; ties keep path order so the table is stable. */
export function sortSeoRows(
  rows: SeoOverviewRow[],
  key: SeoSortKey,
  dir: SortDir
): SeoOverviewRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va !== vb && (va === null || vb === null)) {
      return va === null ? 1 : -1;
    }
    if (va !== null && vb !== null && va < vb) {
      return -sign;
    }
    if (va !== null && vb !== null && va > vb) {
      return sign;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** Rows with a failure, a warning or a duplicate. */
export function rowsWithIssues(rows: SeoOverviewRow[]): SeoOverviewRow[] {
  return rows.filter(
    (r) =>
      r.fails > 0 || r.warns > 0 || r.duplicateTitle || r.duplicateDescription
  );
}

/** Adds each page's Search Console totals (`byPageId`, from getSeoGscOverviewFn) to its row. */
export function withGscMetrics(
  rows: SeoOverviewRow[],
  byPageId: Record<string, GscMetrics>
): SeoOverviewRow[] {
  return rows.map((r) => ({ ...r, gsc: byPageId[r.id] ?? null }));
}
