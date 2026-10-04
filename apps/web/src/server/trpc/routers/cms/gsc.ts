import type { PagePerformance, SeoGscOverview } from "@repo/cms-core/gsc/shape";
import type { AdminResult } from "@repo/services/cms/admin-result";
import type { GscActionResult } from "@repo/services/gsc/admin";
import { z } from "zod";
import { adminProcedure, router } from "../../init.ts";

/**
 * Search Console in the admin (docs/cms-plan.md §3.10): the SEO tab's "Search performance", the
 * /admin/seo columns and Opportunities, and the two calls to Google ("Inspect now", "Resubmit
 * sitemap"). The reads only touch D1, which the cron and scripts fill; `connected` says whether the
 * GSC secrets and `GSC_PROPERTY` are set. The Google calls answer `{ ok: false, message }` instead
 * of throwing when Search Console refuses.
 */

export type { GscActionResult } from "@repo/services/gsc/admin";

const pageId = z.string().max(64, 'Expected "pageId" to be a string');

const pagePerformanceInput = z.object({
  pageId,
  days: z.union([z.literal(28), z.literal(90)], {
    error: 'Expected "days" to be 28 or 90',
  }),
});

const overviewInput = z
  .object({
    minImpressions: z
      .int('Expected "minImpressions" to be a whole number')
      .min(0, 'Expected "minImpressions" to be a whole number')
      .max(1_000_000, 'Expected "minImpressions" to be a whole number')
      .optional(),
  })
  .optional();

export const gscRouter = router({
  /** The SEO tab's "Search performance" for one page over 28 or 90 days. */
  getPagePerformance: adminProcedure
    .input(pagePerformanceInput)
    .query(
      ({
        ctx,
        input,
      }): Promise<
        AdminResult<{ performance: PagePerformance; connected: boolean }>
      > => ctx.services.cms.gsc.pagePerformance(input)
    ),

  /** /admin/seo: 28-day clicks/impressions/position per page and the Opportunities lists. */
  getSeoGscOverview: adminProcedure
    .input(overviewInput)
    .query(
      ({
        ctx,
        input,
      }): Promise<AdminResult<{ gsc: SeoGscOverview; connected: boolean }>> =>
        ctx.services.cms.gsc.seoOverview(input ?? {})
    ),

  /** Not indexed → "Inspect now": a fresh URL Inspection of one published page. */
  inspectPageNow: adminProcedure
    .input(z.object({ pageId }))
    .mutation(
      ({ ctx, input }): Promise<GscActionResult<{ inspected: boolean }>> =>
        ctx.services.cms.gsc.inspectPageNow(input)
    ),

  /** Not indexed → "Resubmit sitemap": tells Google the sitemap changed. */
  submitSitemap: adminProcedure.mutation(
    ({ ctx }): Promise<GscActionResult> => ctx.services.cms.gsc.submitSitemap()
  ),
});
