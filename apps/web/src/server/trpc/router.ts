import { adminProcedure, protectedProcedure, router } from "./init.ts";
import { agentRouter } from "./routers/cms/agent.ts";
import { agentRenderRouter } from "./routers/cms/agent-render.ts";
import { agentRunsRouter } from "./routers/cms/agent-runs.ts";
import { apiKeysRouter } from "./routers/cms/api-keys.ts";
import { gscRouter } from "./routers/cms/gsc.ts";
import { mediaRouter } from "./routers/cms/media.ts";
import { ogRenderRouter } from "./routers/cms/og-render.ts";
import { pagesRouter } from "./routers/cms/pages.ts";
import { postsRouter } from "./routers/cms/posts.ts";
import { previewRouter } from "./routers/cms/preview.ts";
import { publicRouter } from "./routers/cms/public.ts";
import { seoRouter } from "./routers/cms/seo.ts";
import { setupRouter } from "./routers/cms/setup.ts";
import { shareImageRouter } from "./routers/cms/share-image.ts";
import { siteRouter } from "./routers/cms/site.ts";

export const appRouter = router({
  /** Whether the caller is an admin. */
  isAdmin: adminProcedure.query(({ ctx }) => ({ email: ctx.adminEmail })),
  /** The caller's user id. */
  me: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
  cms: router({
    agent: agentRouter,
    agentRender: agentRenderRouter,
    agentRuns: agentRunsRouter,
    apiKeys: apiKeysRouter,
    gsc: gscRouter,
    media: mediaRouter,
    ogRender: ogRenderRouter,
    pages: pagesRouter,
    posts: postsRouter,
    preview: previewRouter,
    public: publicRouter,
    seo: seoRouter,
    setup: setupRouter,
    shareImage: shareImageRouter,
    site: siteRouter,
  }),
});

export type AppRouter = typeof appRouter;
