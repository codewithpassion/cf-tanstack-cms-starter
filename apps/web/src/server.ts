import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware } from "@clerk/hono";
import { trpcServer } from "@hono/trpc-server";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { skipsClerk } from "#/lib/clerk-skip";
import { withHandlerCookies } from "#/lib/handler-cookies";
import { DEFAULT_SIGN_IN_TARGET, safeRedirectPath } from "#/lib/sign-in-target";
import { scheduled } from "./scheduled.ts";
import { createHonoContext } from "./server/trpc/context.ts";
import { appRouter } from "./server/trpc/router.ts";

const app = new Hono<{ Bindings: Env }>();

// Security headers on every HTML response. SAMEORIGIN, not DENY: the editor's canvas frames the
// site's own pages. The MCP consent page (/oauth/authorize) sends its own DENY.
app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
    if (!c.res.headers.has("X-Frame-Options")) {
      c.header("X-Frame-Options", "SAMEORIGIN");
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  }
});

// One URL per page: /foo/ permanently redirects to /foo (query kept). The router's own
// trailing-slash redirect is a 307, which search engines treat as temporary.
const TRAILING_SLASHES_RE = /\/+$/;

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const isRead = c.req.method === "GET" || c.req.method === "HEAD";
  if (isRead && url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(TRAILING_SLASHES_RE, "") || "/";
    return new Response(null, {
      headers: { Location: url.toString() },
      status: 301,
    });
  }
  await next();
});

// Before the Clerk middleware on purpose: the health check works without Clerk keys.
app.get("/api/health", (c) => c.json({ status: "ok" }));

// MCP OAuth: the authorization server's metadata, token and registration endpoints and /mcp's
// RFC 9728 metadata, answered by @cloudflare/workers-oauth-provider before Clerk and TanStack
// (all cookieless). /oauth/authorize and /mcp are TanStack routes. Imported lazily so page
// requests never load the library.
app.use("*", async (c, next) => {
  const { path } = c.req;
  if (path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) {
    const { handleOAuthEndpoint } = await import("./server/mcp/oauth.ts");
    const res = await handleOAuthEndpoint(c.env, c.req.raw);
    if (res) {
      return res;
    }
  }
  await next();
});

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

  // Back to the page that asked for a sign-in (`/login?redirect_url=...`), else the admin.
  const target =
    safeRedirectPath(c.req.query("redirect_url")) ?? DEFAULT_SIGN_IN_TARGET;
  return c.redirect(
    `/dev-login?token=${encodeURIComponent(token)}&redirect_url=${encodeURIComponent(target)}`
  );
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

// Everything else is handled by TanStack Start (SSR pages, raw routes and assets). Its cookies are
// kept alongside any Clerk set while refreshing the session (lib/handler-cookies.ts).
app.all("*", async (c) =>
  withHandlerCookies(c, await handler.fetch(c.req.raw))
);

export default {
  fetch: app.fetch,
  /** Cron Trigger (wrangler.jsonc `triggers.crons`, daily): see scheduled.ts. */
  scheduled,
} satisfies ExportedHandler<Env>;
