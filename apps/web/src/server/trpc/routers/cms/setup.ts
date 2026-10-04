import { adminResult } from "@repo/services/cms/admin-errors";
import type { AdminResult } from "@repo/services/cms/admin-result";
import { gscCredentials } from "@repo/services/gsc/client";
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

export const setupRouter = router({
  /** How many pages the CMS holds here, how many are live, and whether Search Console is connected. */
  setupStatus: adminProcedure.query(
    ({ ctx }): Promise<AdminResult<SetupStatus>> =>
      adminResult(async () => {
        // Loaded here, not at the top, so tests can import this router without the Workers runtime.
        const { env } = await import("cloudflare:workers");
        const pages = await ctx.services.cms.pages.listPages();
        return {
          pages: pages.length,
          published: pages.filter((p) => p.status === "published").length,
          gscConfigured: gscCredentials(env) !== null,
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
});
