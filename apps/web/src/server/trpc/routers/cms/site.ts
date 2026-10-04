import type { BrandSwatch, SiteDoc } from "@repo/cms-core/site/types";
import { adminResult } from "@repo/services/cms/admin-errors";
import type { AdminResult } from "@repo/services/cms/admin-result";
import type { SitePublishResult } from "@repo/services/cms/site-service";
import { z } from "zod";
import type { CmsServices } from "../../../cms/wiring.ts";
import { adminProcedure, router } from "../../init.ts";
import {
  cursor,
  int,
  isVersionLabel,
  obj,
  str,
  VERSION_LABEL_MESSAGE,
} from "./input-fields.ts";

/**
 * The site settings (`/admin/site`, docs/cms-plan.md §3.7): nav, footer, SEO defaults and brand
 * swatches. Admin only; expected failures come back as `{ ok: false, code }`.
 */

export const SITE_HISTORY_PAGE_SIZE = 50;

export type SiteEditorState = {
  doc: SiteDoc;
  draftVersion: number;
  liveRevId: string | null;
  /** What publishing would change on the public site. */
  changes: string[];
};

export type SiteRevisionItem = {
  id: string;
  kind: "autosnapshot" | "named" | "published" | "restore";
  /** The name given with "Save version…". */
  label: string | null;
  summary: string | null;
  byYou: boolean;
  /** ISO timestamp. */
  createdAt: string;
  isLive: boolean;
};

/** The editor's state, without the live doc the service also returns. */
async function editorState(
  site: CmsServices["site"]
): Promise<SiteEditorState> {
  const { doc, draftVersion, liveRevId, changes } = await site.getSiteState();
  return { doc, draftVersion, liveRevId, changes };
}

export const siteRouter = router({
  getSite: adminProcedure.query(
    ({ ctx }): Promise<AdminResult<SiteEditorState>> =>
      adminResult(() => editorState(ctx.services.cms.site))
  ),

  /**
   * Replaces the draft with `doc` (validated by the service) when it is still `draftVersion`.
   * `batchId`: the editor's idempotency key for this save (resent unchanged on a retry).
   */
  saveSiteDraft: adminProcedure
    .input(
      obj({
        draftVersion: int("draftVersion"),
        batchId: str("batchId", 64).optional(),
        doc: z.unknown(),
      })
    )
    .mutation(
      ({ ctx, input }): Promise<AdminResult<SiteEditorState>> =>
        adminResult(async () => {
          const { site } = ctx.services.cms;
          await site.saveSiteDraft(
            input.draftVersion,
            input.doc,
            input.batchId
          );
          return editorState(site);
        })
    ),

  publishSite: adminProcedure
    .input(obj({ draftVersion: int("draftVersion") }))
    .mutation(
      ({ ctx, input }): Promise<AdminResult<SitePublishResult>> =>
        adminResult(() => ctx.services.cms.site.publishSite(input.draftVersion))
    ),

  /** Retry after a publish whose KV write failed (`live: false`). */
  republishSite: adminProcedure.mutation(
    ({ ctx }): Promise<AdminResult<SitePublishResult>> =>
      adminResult(() => ctx.services.cms.site.republishSite())
  ),

  /** `cursor`: the previous page's `nextCursor`; omit for the newest entries. */
  siteHistory: adminProcedure
    .input(obj({ cursor: cursor(9).optional() }))
    .query(
      ({
        ctx,
        input,
      }): Promise<
        AdminResult<{
          revisions: SiteRevisionItem[];
          nextCursor: string | null;
        }>
      > => {
        const offset = Number(input.cursor ?? "0");
        return adminResult(async () => {
          const { revisions, liveRevId, hasMore } =
            await ctx.services.cms.site.siteHistory({
              limit: SITE_HISTORY_PAGE_SIZE,
              offset,
            });
          return {
            revisions: revisions.map((r) => ({
              id: r.id,
              kind: r.kind,
              label: r.label,
              summary: r.summary,
              byYou: r.author === ctx.userId,
              createdAt: r.createdAt.toISOString(),
              isLive: r.id === liveRevId,
            })),
            nextCursor: hasMore ? String(offset + revisions.length) : null,
          };
        });
      }
    ),

  /** Makes a revision the draft (a new `restore` revision). Publish afterwards to make it live. */
  restoreSite: adminProcedure
    .input(obj({ revId: str("revId", 64), draftVersion: int("draftVersion") }))
    .mutation(
      ({ ctx, input }): Promise<AdminResult<SiteEditorState>> =>
        adminResult(async () => {
          const { site } = ctx.services.cms;
          await site.restoreSite(input.revId, input.draftVersion);
          return editorState(site);
        })
    ),

  /** "Save version…": a named revision of the saved draft, which must still be `draftVersion`. */
  saveSiteVersion: adminProcedure
    .input(
      obj({
        draftVersion: int("draftVersion"),
        label: str("label", 1000)
          .refine(isVersionLabel, { error: VERSION_LABEL_MESSAGE })
          .transform((v) => v.trim()),
      })
    )
    .mutation(
      ({ ctx, input }): Promise<AdminResult<{ revId: string }>> =>
        adminResult(() =>
          ctx.services.cms.site.saveSiteVersion(input.label, input.draftVersion)
        )
    ),

  /** An autosnapshot of the saved draft before a destructive edit (`reason` starts its summary). */
  snapshotSite: adminProcedure
    .input(
      obj({ draftVersion: int("draftVersion"), reason: str("reason", 200) })
    )
    .mutation(
      ({ ctx, input }): Promise<AdminResult<{ revId: string | null }>> =>
        adminResult(() =>
          ctx.services.cms.site.snapshotSite(input.draftVersion, input.reason)
        )
    ),

  /** The saved brand swatches (draft), for the editor's colour picker. */
  getSiteSwatches: adminProcedure.query(
    ({ ctx }): Promise<AdminResult<{ swatches: BrandSwatch[] }>> =>
      adminResult(async () => ({
        swatches: (await ctx.services.cms.site.getSiteState()).doc.swatches,
      }))
  ),
});
