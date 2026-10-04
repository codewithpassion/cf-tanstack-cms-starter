import { adminProcedure, protectedProcedure, router } from "./init.ts";

export const appRouter = router({
  /** Whether the caller is an admin. The example admin procedure. */
  isAdmin: adminProcedure.query(({ ctx }) => ({ email: ctx.adminEmail })),
  /** The caller's user id. The example protected procedure. */
  me: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
  // TODO(cms-port): the CMS routers (pages, site, posts, media, ...) are mounted here.
});

export type AppRouter = typeof appRouter;
