import { adminResult } from "@repo/services/cms/admin-errors";
import type { AdminResult } from "@repo/services/cms/admin-result";
import { CmsError } from "@repo/services/cms/pages-service";
import { signPreviewLink } from "@repo/services/cms/preview-link";
import { PREVIEW_TOKEN_TTL_SECONDS } from "@repo/services/cms/render-token";
import { adminProcedure, router } from "../../init.ts";
import { obj, str } from "./input-fields.ts";

/** The editor's Preview and Publish buttons (docs/cms-plan.md §3.6). Admin only. */

/** `url`: the page's public path with `?_preview=<token>`. `expiresAt`: ISO timestamp. */
export type PreviewLink = { url: string; expiresAt: string };

/** `live`: the published revision's document as JSON text, or null when the page isn't live. */
export type LiveDoc = { live: { revId: string; docJson: string } | null };

const pageInput = obj({ pageId: str("pageId", 64) });

export const previewRouter = router({
  /**
   * A link that shows the page's saved DRAFT on its public URL for 24 hours, without signing in
   * (preview-link.ts). Blog posts preview on their blog/<slug> URL. Save the draft first: the link
   * shows what D1 holds.
   */
  createPreviewLink: adminProcedure.input(pageInput).mutation(
    ({ ctx, input }): Promise<AdminResult<PreviewLink>> =>
      adminResult(async () => {
        const { pages, signer } = ctx.services.cms;
        const page = await pages.getPage({ id: input.pageId });
        if (!page) {
          throw new CmsError("NOT_FOUND", `Page ${input.pageId} not found`);
        }
        const link = await signPreviewLink(signer, page, {
          ttlSeconds: PREVIEW_TOKEN_TTL_SECONDS,
        });
        return { url: link.path, expiresAt: link.expiresAt };
      })
  ),

  /** The live revision now (not as the editor loaded it: a publish or rollback moves it), for the publish dialog's diff. */
  getLiveDoc: adminProcedure.input(pageInput).query(
    ({ ctx, input }): Promise<AdminResult<LiveDoc>> =>
      adminResult(async () => {
        const { pages } = ctx.services.cms;
        const page = await pages.getPage({ id: input.pageId });
        if (!page) {
          throw new CmsError("NOT_FOUND", `Page ${input.pageId} not found`);
        }
        const rev =
          page.status === "published" && page.liveRevId
            ? await pages.getRevision(page.liveRevId)
            : null;
        return {
          live: rev
            ? { revId: rev.id, docJson: JSON.stringify(rev.docJson) }
            : null,
        };
      })
  ),
});
