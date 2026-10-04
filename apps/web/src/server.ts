import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware } from "@clerk/hono";
import { trpcServer } from "@hono/trpc-server";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { skipsClerk } from "#/lib/clerk-skip";
import { createHonoContext } from "./server/trpc/context.ts";
import { appRouter } from "./server/trpc/router.ts";

const app = new Hono<{ Bindings: Env }>();

// Before the Clerk middleware on purpose: the health check works without Clerk keys.
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Clerk on every request except the public ones in lib/clerk-skip.ts, which go
// straight to TanStack Start.
const clerk = clerkMiddleware();
app.use("*", async (c, next) =>
  skipsClerk(c.req.path) ? await handler.fetch(c.req.raw) : clerk(c, next)
);

// One-click dev login: mints a one-time Clerk sign-in token for the dev user
// and hands it to /dev-login to redeem client-side. Only active when
// DEV_LOGIN_EMAIL is configured, which must never be set in a deployed
// environment - that absence is the safety switch for this route.
app.get("/api/dev-login", async (c) => {
  const email = c.env.DEV_LOGIN_EMAIL;
  if (!email) {
    return c.text("Dev login is not configured.", 404);
  }

  const clerkClient = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
  const { data } = await clerkClient.users.getUserList({
    emailAddress: [email],
  });
  const [user] = data;
  if (!user) {
    return c.text(
      `Dev login user ${email} does not exist yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
  }

  const { token } = await clerkClient.signInTokens.createSignInToken({
    expiresInSeconds: 60,
    userId: user.id,
  });

  return c.redirect(`/dev-login?token=${encodeURIComponent(token)}`);
});

// tRPC: queries and mutations for the browser. During SSR the loaders call the
// same router in-process instead (src/integrations/trpc/client.ts).
// csrf() rejects cross-site POSTs with form content types, which browsers send
// without a preflight. JSON POSTs are safe only because a cross-site one needs
// a CORS preflight that nothing here answers: adding cors() to these routes
// would leave mutations open to CSRF.
app.use("/api/trpc/*", csrf());
app.use(
  "/api/trpc/*",
  trpcServer({
    createContext: (_opts, c) => createHonoContext(c),
    endpoint: "/api/trpc",
    // Production clients only see "Internal server error" (see init.ts), so
    // the real error goes to the Worker logs.
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        console.error(`tRPC ${path ?? "?"} failed:`, error.cause ?? error);
      }
    },
    router: appRouter,
  })
);

// Everything else is handled by TanStack Start (SSR pages and assets).
app.all("*", (c) => handler.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  /**
   * Cron Trigger (wrangler.jsonc `triggers.crons`, daily). Empty on purpose.
   * TODO(cms-port): the daily Search Console sync and MCP call-log cleanup.
   */
  scheduled: (
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> => Promise.resolve(),
} satisfies ExportedHandler<Env>;
