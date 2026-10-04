import type { PostSummary } from "@repo/cms-core/posts";
import { readPostsIndex } from "@repo/services/cms/pages-index";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  agentRenderDeps,
  readAgentRenderData,
} from "../../../routes/og-render-agent.ts";
import { publicProcedure, router } from "../../init.ts";

/**
 * The agent render target's data (routes/og-render-agent.$pageId.tsx). Public because Browser Run
 * has no session; the "og" render token in `search.t` (bound to the page's id and slug) is the
 * credential, and it is checked here as well as in the route's request gate, since /api/trpc is
 * not behind that gate.
 */

const getAgentRenderDataInput = z.object({
  pageId: z.string().min(1).max(64),
  // The route's raw search: `t` (the token) and optionally `cs` (a staged changeset's id).
  search: z.record(z.string(), z.unknown()),
});

export const agentRenderRouter = router({
  /**
   * The page's draft, or the proposed page of the changeset `search.cs` names, with its kind, and
   * the published posts when the page has a `postList` block. FORBIDDEN without a valid token for
   * this page (or for a changeset of another page).
   */
  getAgentRenderData: publicProcedure
    .input(getAgentRenderDataInput)
    .query(async ({ ctx, input }) => {
      const { cms } = ctx.services;
      const data = await readAgentRenderData(agentRenderDeps(cms), input);
      if (!data) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }
      const posts: PostSummary[] = JSON.stringify(data.doc).includes(
        '"_type":"postList"'
      )
        ? await readPostsIndex(cms.kv)
        : [];
      return { ...data, posts };
    }),
});
