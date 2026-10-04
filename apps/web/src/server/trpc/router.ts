import { adminProcedure, protectedProcedure, router } from "./init.ts";
import { apiKeysRouter } from "./routers/cms/api-keys.ts";
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
    apiKeys: apiKeysRouter,
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
  // TODO(cms-port-agent): cms.agent, cms.agentRuns and cms.gsc routers arrive with Phase 2B's services.
});

export type AppRouter = typeof appRouter;
