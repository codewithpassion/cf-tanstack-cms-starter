import { newPageDoc } from "@repo/cms-core/new-docs";
import { slugToPath } from "@repo/cms-core/paths";
import { adminResult } from "@repo/services/cms/admin-errors";
import type {
  AdminResult,
  EditorPageWire,
  PageListItem,
  PublishPageResult,
  SaveDraftResult,
} from "@repo/services/cms/admin-result";
import type { PageMeta } from "@repo/services/cms/repo";
import { z } from "zod";
import { adminProcedure, router } from "../../init.ts";
import {
  bool,
  cursor,
  int,
  isVersionLabel,
  obj,
  str,
  title,
  VERSION_LABEL_MESSAGE,
} from "./input-fields.ts";

/**
 * The page editor and its history panel (docs/cms-plan.md §3.6, §3.2). Every procedure is admin
 * only; expected failures come back as `{ ok: false, code, message, path? }` (admin-errors.ts).
 * The services in `ctx.services.cms` already record the caller as the author of what they write.
 */

const id64 = (key: string) => str(key, 64);

/** A version name: 1–80 characters once trimmed (the service trims). */
const versionLabel = str("label", 400).refine(isVersionLabel, {
  error: VERSION_LABEL_MESSAGE,
});

function listItem(page: PageMeta): PageListItem {
  return {
    id: page.id,
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    status: page.status,
    updatedAt: page.updatedAt.toISOString(),
  };
}

export const pagesRouter = router({
  /** Route guard for admin layouts: the procedure's admin check is the whole job. */
  requireAdmin: adminProcedure.query(() => ({ ok: true as const })),

  listPages: adminProcedure.query(
    ({ ctx }): Promise<AdminResult<{ pages: PageListItem[] }>> =>
      adminResult(async () => ({
        pages: (await ctx.services.cms.pages.listPages()).map(listItem),
      }))
  ),

  /** Live slug check for the "New page" dialog: format, blog/ rule, reserved and taken slugs. */
  checkSlug: adminProcedure.input(obj({ slug: str("slug", 400) })).query(
    ({ ctx, input }): Promise<AdminResult> =>
      adminResult(async () => {
        await ctx.services.cms.pages.checkSlugAvailable("page", input.slug);
        return {};
      })
  ),

  createPage: adminProcedure
    .input(obj({ slug: str("slug", 400), title: title() }))
    .mutation(
      ({ ctx, input }): Promise<AdminResult<{ id: string }>> =>
        adminResult(async () => {
          const { pages } = ctx.services.cms;
          await pages.checkSlugAvailable("page", input.slug);
          const page = await pages.createPage({
            kind: "page",
            slug: input.slug,
            title: input.title,
            doc: newPageDoc(input.title, input.slug),
          });
          return { id: page.id };
        })
    ),

  getEditorPage: adminProcedure
    .input(obj({ id: id64("id") }))
    .query(
      ({ ctx, input }): Promise<AdminResult<EditorPageWire>> =>
        adminResult(() => ctx.services.cms.history.editorPage(input.id))
    ),

  /** `batchId`: the editor's idempotency key for this batch (resent unchanged on a retry). */
  saveDraftOps: adminProcedure
    .input(
      obj({
        pageId: id64("pageId"),
        draftVersion: int("draftVersion"),
        batchId: id64("batchId").optional(),
        // Checked by the service (parseOps): INVALID_OPS with a path.
        ops: z.unknown(),
      })
    )
    .mutation(
      ({ ctx, input }): Promise<AdminResult<SaveDraftResult>> =>
        adminResult(async () => {
          const { draftVersion, doc } =
            await ctx.services.cms.pages.applyDraftOps(
              input.pageId,
              input.draftVersion,
              input.ops,
              input.batchId
            );
          return { draftVersion, docJson: JSON.stringify(doc) };
        })
    ),

  publishPage: adminProcedure
    .input(
      obj({
        pageId: id64("pageId"),
        draftVersion: int("draftVersion"),
        // The live revision the publish dialog compared against: absent (don't check), null (not live) or its id.
        expectedLiveRevId: id64("expectedLiveRevId").nullable().optional(),
      })
    )
    .mutation(
      ({ ctx, input }): Promise<AdminResult<PublishPageResult>> =>
        adminResult(async () => {
          const { pages } = ctx.services.cms;
          const { live, revId } = await pages.publish(
            input.pageId,
            input.draftVersion,
            { expectedLiveRevId: input.expectedLiveRevId }
          );
          const page = await pages.getPage({ id: input.pageId });
          return { live, revId, path: slugToPath(page?.slug ?? "") };
        })
    ),

  /**
   * Takes a page or post off the site; its draft and history stay. `synced: false` = D1 says
   * unpublished but the site's page store didn't update; unpublishing again clears it.
   */
  unpublishPage: adminProcedure.input(obj({ pageId: id64("pageId") })).mutation(
    ({ ctx, input }): Promise<AdminResult<{ synced: boolean }>> =>
      adminResult(async () => {
        const { synced } = await ctx.services.cms.pages.unpublish(input.pageId);
        return { synced };
      })
  ),

  // -------------------------------------------------------------------------------------------
  // History (docs/cms-plan.md §3.2): bodies in @repo/services/cms/history-admin

  /** `cursor`: from the previous page's `nextCursor`; omit for the newest entries. */
  listRevisions: adminProcedure
    .input(obj({ pageId: id64("pageId"), cursor: cursor(16).optional() }))
    .query(({ ctx, input }) =>
      ctx.services.cms.history.listHistory({
        pageId: input.pageId,
        cursor: input.cursor,
      })
    ),

  /** A revision's document, as JSON text (see EditorPageWire). */
  getRevision: adminProcedure
    .input(obj({ pageId: id64("pageId"), revId: id64("revId") }))
    .query(({ ctx, input }) =>
      ctx.services.cms.history.revisionDoc({
        pageId: input.pageId,
        revId: input.revId,
      })
    ),

  /** "Save version…" of the saved draft. Flush the editor's saves first and pass its `draftVersion`. */
  saveNamedVersion: adminProcedure
    .input(
      obj({
        pageId: id64("pageId"),
        label: versionLabel,
        draftVersion: int("draftVersion").optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.cms.history.saveNamedVersion({
        pageId: input.pageId,
        label: input.label,
        draftVersion: input.draftVersion,
      })
    ),

  restoreRevision: adminProcedure
    .input(
      obj({
        pageId: id64("pageId"),
        revId: id64("revId"),
        draftVersion: int("draftVersion"),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.cms.history.restoreRevision({
        pageId: input.pageId,
        revId: input.revId,
        draftVersion: input.draftVersion,
      })
    ),

  restoreBlockFromRevision: adminProcedure
    .input(
      obj({
        pageId: id64("pageId"),
        revId: id64("revId"),
        blockKey: id64("blockKey"),
        draftVersion: int("draftVersion"),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.cms.history.restoreBlockFromRevision({
        pageId: input.pageId,
        revId: input.revId,
        blockKey: input.blockKey,
        draftVersion: input.draftVersion,
      })
    ),

  /** Republishes an earlier published revision; the draft is untouched. */
  rollbackLive: adminProcedure
    .input(obj({ pageId: id64("pageId"), revId: id64("revId") }))
    .mutation(({ ctx, input }) =>
      ctx.services.cms.history.rollbackLive({
        pageId: input.pageId,
        revId: input.revId,
      })
    ),

  /** Rename (`label`, "" clears the rename) and/or pin (`pinned`) a revision. */
  labelRevision: adminProcedure
    .input(
      obj({
        pageId: id64("pageId"),
        revId: id64("revId"),
        label: str("label", 400)
          .refine((v) => v.trim() === "" || isVersionLabel(v), {
            error: VERSION_LABEL_MESSAGE,
          })
          .optional(),
        pinned: bool("pinned").optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.cms.history.labelRevision({
        pageId: input.pageId,
        revId: input.revId,
        label: input.label,
        pinned: input.pinned,
      })
    ),
});
