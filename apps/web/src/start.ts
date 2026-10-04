import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { skipsClerk } from "#/lib/clerk-skip";
import { needsCsrfCheck } from "#/lib/csrf-filter";

// Defining `startInstance` replaces Start's default request middleware (only its server-function
// CSRF check). The CMS has no server functions (tRPC carries the RPC, guarded by Hono's csrf() in
// src/server.ts), so the check here covers state-changing /admin requests, e.g. the media upload.
const csrfMiddleware = createCsrfMiddleware({ filter: needsCsrfCheck });

// Clerk on every request except the public ones in `skipsClerk`.
const clerk = clerkMiddleware();
// biome-ignore lint/style/noNonNullAssertion: clerkMiddleware always defines a server handler.
const runClerk = clerk.options.server!;
const clerkExceptPublic = createMiddleware().server((ctx) =>
  skipsClerk(new URL(ctx.request.url).pathname) ? ctx.next() : runClerk(ctx)
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, clerkExceptPublic],
}));
