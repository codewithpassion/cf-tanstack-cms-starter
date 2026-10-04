import {
  SHARE_TEMPLATES,
  shareOverridesSchema,
} from "@repo/cms-core/share/params";
import { z } from "zod";
import { adminProcedure, router } from "../../init.ts";

/**
 * Share images (docs/cms-plan.md §3.9). The SEO tab's builder calls this; nothing public triggers
 * a render.
 */

const generateShareImageInput = z.object({
  pageId: z.string().min(1).max(64),
  template: z.enum(SHARE_TEMPLATES),
  overrides: shareOverridesSchema.optional(),
  alt: z.string().max(300).optional(),
});

export const shareImageRouter = router({
  /** Screenshots the page's draft with a template and stores the 1200×630 JPEG as media. */
  generateShareImage: adminProcedure
    .input(generateShareImageInput)
    .mutation(async ({ ctx, input }) => {
      // Loaded here, not at the top, so tests can import this router without the Workers runtime.
      const [{ env }, { createShareImage }] = await Promise.all([
        import("cloudflare:workers"),
        import("../../../adapters/share-image.ts"),
      ]);
      return createShareImage(env, ctx.services.cms, input);
    }),
});
