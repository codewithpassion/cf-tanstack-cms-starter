import type { D1Db } from "@repo/db";
import {
  insertInspection,
  lastInspections,
  pagePerformance,
  publishedPages,
  replaceWindow,
  seoGscOverview,
} from "@repo/db/gsc";

import type { GscQueries } from "./admin";
import type { GscStore } from "./sync";

/**
 * The GSC ports over `@repo/db/gsc` on one database: `@repo/db/gsc` exports plain functions that
 * take `db` first, so these bind it. Typed against the ports, so `tsc` fails here when the table
 * module and a port drift apart.
 */

export const createD1GscStore = (db: D1Db): GscStore => ({
  replaceWindow: (start, end, rows, pageDays) =>
    replaceWindow(db, start, end, rows, pageDays),
  publishedPages: (pageUrl) => publishedPages(db, pageUrl),
  lastInspections: () => lastInspections(db),
  insertInspection: (row) => insertInspection(db, row),
});

export const createD1GscQueries = (db: D1Db): GscQueries => ({
  pagePerformance: (page, days, opts) => pagePerformance(db, page, days, opts),
  seoGscOverview: (opts) => seoGscOverview(db, opts),
});
