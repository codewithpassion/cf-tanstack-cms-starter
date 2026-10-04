import type { SeoOverviewRow } from "@repo/cms-core/seo/overview-table";
import { adminResult } from "@repo/services/cms/admin-errors";
import type { AdminResult } from "@repo/services/cms/admin-result";
import { z } from "zod";
import {
  checkSeoSlug,
  type SeoContextResult,
  seoContext,
  seoOverview,
} from "../../../cms/seo.ts";
import { adminProcedure, router } from "../../init.ts";

/** The SEO tab and /admin/seo (docs/cms-plan.md §3.9). */

export type { SeoContextResult } from "../../../cms/seo.ts";

const pageIdInput = z.object({ pageId: z.string().max(64) });

const checkSeoSlugInput = z.object({
  pageId: z.string().max(64),
  slug: z.string().max(400),
});

export const seoRouter = router({
  /** What the SEO checks need beyond the document: other pages' titles/descriptions, media sizes, the live slug. */
  getSeoContext: adminProcedure
    .input(pageIdInput)
    .query(
      ({ ctx, input }): Promise<AdminResult<SeoContextResult>> =>
        adminResult(() => seoContext(ctx.services.cms, input.pageId))
    ),

  /** The SEO tab's slug check for an existing page: the rules publishing enforces. */
  checkSeoSlug: adminProcedure
    .input(checkSeoSlugInput)
    .query(
      ({ ctx, input }): Promise<AdminResult> =>
        adminResult(() => checkSeoSlug(ctx.services.cms, input))
    ),

  /** Every non-archived page with its SEO checks, score and duplicate flags. */
  listSeoOverview: adminProcedure.query(
    ({ ctx }): Promise<AdminResult<{ rows: SeoOverviewRow[] }>> =>
      adminResult(() => seoOverview(ctx.services.cms))
  ),
});
