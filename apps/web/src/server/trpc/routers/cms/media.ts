import { mediaIdSchema } from "@repo/cms-core/media-schema";
import { mediaUsage } from "@repo/db/media";
import { z } from "zod";
import { adminProcedure, router } from "../../init.ts";

/**
 * The media library's admin procedures (uploads go through POST /admin/api/media, a Hono route).
 * Admin is asserted before the input is parsed, so a non-admin learns nothing about its input.
 */

const listMediaInput = z.object({
  query: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
  includeAgent: z.boolean().optional(),
});

const mediaIdInput = z.object({ id: mediaIdSchema });

const updateMediaAltInput = z.object({
  id: mediaIdSchema,
  alt: z.string().max(300),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export const mediaRouter = router({
  listMedia: adminProcedure
    .input(listMediaInput)
    .query(({ ctx, input }) => ctx.services.cms.media.listMedia(input)),

  /** One item's library record (alt text, size), or null when it isn't in the library. */
  getMediaInfo: adminProcedure
    .input(mediaIdInput)
    .query(({ ctx, input }) => ctx.services.cms.media.getMedia(input.id)),

  updateMediaAlt: adminProcedure
    .input(updateMediaAltInput)
    .mutation(({ ctx, input }) => ctx.services.cms.media.updateMediaAlt(input)),

  /** /admin/media "Used on": pages (not archived) and the site settings whose draft or live version references the image. */
  getMediaUsage: adminProcedure
    .input(mediaIdInput)
    .query(({ ctx, input }) => mediaUsage(ctx.services.cms.db, input.id)),
});
