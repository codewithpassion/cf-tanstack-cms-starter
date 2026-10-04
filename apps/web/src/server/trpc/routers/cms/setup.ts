import {
  backfillWindows,
  GSC_CONNECT_HINT,
  GSC_RETENTION_MONTHS,
  gscDayOf,
} from "@repo/cms-core/gsc/shape";
import { adminResult } from "@repo/services/cms/admin-errors";
import type { AdminResult } from "@repo/services/cms/admin-result";
import { createD1GscStore } from "@repo/services/gsc/d1";
import { type SyncSummary, syncSearchAnalytics } from "@repo/services/gsc/sync";
import { z } from "zod";
import {
  type ImportItem,
  planImport,
  runImport,
  SETUP_IMPORT_NAMES,
  SETUP_IMPORTS,
} from "../../../cms/doc-import.ts";
import { adminProcedure, router } from "../../init.ts";

/**
 * /admin/setup: one-off setup steps run inside the deployed Worker, so a new environment can be
 * filled from the browser without local access to its D1 and KV. The import creates missing pages
 * as drafts and never overwrites one (cms/doc-import.ts).
 */

export type SetupStatus = {
  pages: number;
  published: number;
  gscConfigured: boolean;
};

const importInput = z.object({
  which: z.enum(SETUP_IMPORT_NAMES, {
    error: `Expected "which" to be one of: ${SETUP_IMPORT_NAMES.join(", ")}`,
  }),
});

/** Search Console backfill: the month windows to pull, oldest first, and whether Search Console is connected. */
export type BackfillPlan = {
  configured: boolean;
  windows: { start: string; end: string }[];
};

const MONTHS_ERROR = `Expected "months" to be a whole number from 1 to ${GSC_RETENTION_MONTHS}`;

const planBackfillInput = z.object({
  months: z
    .int(MONTHS_ERROR)
    .min(1, MONTHS_ERROR)
    .max(GSC_RETENTION_MONTHS, MONTHS_ERROR),
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_ERROR = 'Expected "start" and "end" as YYYY-MM-DD';
/** A window is at most a calendar month (31 days, `backfillWindows`), so each call stays small. */
const MAX_WINDOW_MS = 31 * 86_400_000;

const backfillMonthInput = z
  .object({
    start: z.string().regex(DAY_RE, DAY_ERROR),
    end: z.string().regex(DAY_RE, DAY_ERROR),
  })
  .refine(
    ({ start, end }) => {
      const span =
        Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
      return span >= 0 && span < MAX_WINDOW_MS;
    },
    { error: "Expected a window of at most 31 days, start before end" }
  );

export const setupRouter = router({
  /** How many pages the CMS holds here, how many are live, and whether Search Console is connected. */
  setupStatus: adminProcedure.query(
    ({ ctx }): Promise<AdminResult<SetupStatus>> =>
      adminResult(async () => {
        const pages = await ctx.services.cms.pages.listPages();
        return {
          pages: pages.length,
          published: pages.filter((p) => p.status === "published").length,
          gscConfigured: ctx.services.cms.gscConfigured,
        };
      })
  ),

  /** A dry run: what the import would do, page by page. Writes nothing. */
  planSetupImport: adminProcedure.input(importInput).query(
    ({ ctx, input }): Promise<AdminResult<{ items: ImportItem[] }>> =>
      adminResult(async () => ({
        items: await planImport(
          ctx.services.cms.pagesDeps,
          SETUP_IMPORTS[input.which]()
        ),
      }))
  ),

  /** Runs the import: creates missing pages as drafts, skips existing ones (idempotent). */
  runSetupImport: adminProcedure.input(importInput).mutation(
    ({ ctx, input }): Promise<AdminResult<{ items: ImportItem[] }>> =>
      adminResult(async () => ({
        items: await runImport(
          ctx.services.cms.pagesDeps,
          SETUP_IMPORTS[input.which]()
        ),
      }))
  ),

  /** The backfill's month windows (Search Console's own day, Pacific time), oldest first. */
  planGscBackfill: adminProcedure.input(planBackfillInput).query(
    ({ ctx, input }): Promise<AdminResult<BackfillPlan>> =>
      adminResult(() =>
        Promise.resolve({
          configured: ctx.services.cms.gscConfigured,
          windows: backfillWindows(gscDayOf(Date.now()), input.months),
        })
      )
  ),

  /**
   * Pulls one window (a month from `planGscBackfill`) into D1, replacing that window's rows. The
   * page calls this once per month, so no single request does the whole backfill. Without Search
   * Console it throws (as the source did): the page only offers it when `configured`.
   */
  runGscBackfillMonth: adminProcedure
    .input(backfillMonthInput)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<AdminResult<{ summary: SyncSummary }>> => {
        const client = ctx.services.cms.gscClient;
        if (!client) {
          throw new Error(GSC_CONNECT_HINT);
        }
        const summary = await syncSearchAnalytics(
          { store: createD1GscStore(ctx.services.cms.db), client },
          input
        );
        return { ok: true, summary };
      }
    ),
});
