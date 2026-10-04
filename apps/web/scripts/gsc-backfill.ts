#!/usr/bin/env bun
// biome-ignore-all lint/performance/noAwaitInLoops: one month at a time on purpose, so each API pull and D1 batch stays small.
// biome-ignore-all lint/suspicious/noConsole: a terminal script; its output is the user interface.
/**
 * One-off Search Console backfill into the LOCAL D1 (`.wrangler/state/v3`, as used by `bun run dev`):
 * up to 16 months (Search Console's retention) of date × page × query × device rows and date ×
 * page totals, pulled a month at a time with the same client and sync code as the daily cron.
 * Credentials come from .env.local (GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN; get the
 * token with `bun run gsc:auth`), the property from the GSC_PROPERTY var. Never touches remote
 * resources: deployed environments run the same backfill from /admin/setup. Idempotent: each month
 * replaces that month's rows.
 *
 *   bun run gsc:backfill                  # 16 months
 *   bun run gsc:backfill --months 3       # fewer
 *   bun run gsc:backfill --row-limit 500  # smaller API pages (exercises pagination)
 *
 * Stop the dev server first if D1 reports SQLITE_BUSY.
 */
import { parseArgs } from "node:util";
import {
  backfillWindows,
  GSC_RETENTION_MONTHS,
  gscDayOf,
} from "@repo/cms-core/gsc/shape";
import { createD1GscStore } from "@repo/services/gsc/d1";
import { syncSearchAnalytics } from "@repo/services/gsc/sync";
import { getPlatformProxy } from "wrangler";
import { gscClientFor } from "../src/server/adapters/gsc.ts";
import { createDb } from "../src/server/cms/wiring.ts";

const { values } = parseArgs({
  options: {
    months: { default: String(GSC_RETENTION_MONTHS), type: "string" },
    "row-limit": { type: "string" },
  },
});
const months = Math.min(
  GSC_RETENTION_MONTHS,
  Math.max(1, Number(values.months))
);
const rowLimit = values["row-limit"] ? Number(values["row-limit"]) : undefined;

const { env, dispose } = await getPlatformProxy<Env>({
  configPath: "wrangler.jsonc",
  persist: { path: ".wrangler/state/v3" },
  remoteBindings: false,
});
try {
  const client = gscClientFor(env);
  if (!client) {
    throw new Error(
      "Set GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN in .env.local (bun run gsc:auth), and GSC_PROPERTY in wrangler.jsonc or .env.local."
    );
  }
  const deps = { client, store: createD1GscStore(createDb(env)) };

  let total = { pageDays: 0, rows: 0 };
  // Calendar-month chunks keep each API response and D1 batch small.
  for (const { start, end } of backfillWindows(gscDayOf(Date.now()), months)) {
    const s = await syncSearchAnalytics(deps, { end, rowLimit, start });
    console.log(
      `${start} … ${end}: ${s.rows} query rows, ${s.pageDays} page-days${s.skipped ? ` (${s.skipped})` : ""}`
    );
    total = {
      pageDays: total.pageDays + s.pageDays,
      rows: total.rows + s.rows,
    };
  }
  console.log(
    `Done: ${total.rows} query rows, ${total.pageDays} page-days into local D1.`
  );
} finally {
  await dispose();
}
