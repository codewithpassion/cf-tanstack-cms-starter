import { getPage } from "@repo/services/cms/pages-service";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { readOgRenderData } from "../../../routes/og-render.ts";
import { publicProcedure, router } from "../../init.ts";

/**
 * The share-image render target's data (routes/og-render.$.tsx). Public because Browser Run has
 * no session; the "og" render token in `search.t` is the credential, and it is checked here as
 * well as in the route's request gate, since /api/trpc is not behind that gate.
 */

const getOgRenderDataInput = z.object({
  slug: z.string().max(200),
  // The route's raw search (`t` plus template parameters); parsed by parseShareParams.
  search: z.record(z.string(), z.unknown()),
});

export const ogRenderRouter = router({
  /** The page's draft and template parameters, or null when the page has no draft. */
  getOgRenderData: publicProcedure
    .input(getOgRenderDataInput)
    .query(async ({ ctx, input }) => {
      const { signer, pagesDeps } = ctx.services.cms;
      const data = await readOgRenderData(
        { signer, findPage: (slug) => getPage(pagesDeps, { slug }) },
        input
      );
      if (data.ok) {
        return { doc: data.doc, kind: data.kind, params: data.params };
      }
      if (data.reason === "forbidden") {
        throw new TRPCError({ code: "FORBIDDEN", message: data.message });
      }
      if (data.reason === "bad-params") {
        throw new TRPCError({ code: "BAD_REQUEST", message: data.message });
      }
      return null;
    }),
});
