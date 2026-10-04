// What every tRPC procedure receives as `ctx`: the services and who is calling.
// `userId` is the Clerk user, or null for anonymous callers; `protectedProcedure`
// rejects the latter. `auth` and `adminEmails` are what `adminProcedure` (init.ts)
// needs to decide whether the caller is an admin.
import { env } from "cloudflare:workers";
import { getAuth } from "@clerk/hono";
import { auth } from "@clerk/tanstack-react-start/server";
import { getRequest } from "@tanstack/react-start/server";
import type { Context as HonoContext } from "hono";
import { lookupVerifiedEmails } from "../cms/admin.ts";
import { parseAdminEmails } from "../cms/admin-match.ts";
import { type CmsServices, cmsServices } from "../cms/wiring.ts";

/** Who is calling. `verifiedEmails` asks Clerk lazily, so only admin checks pay for it. */
export type CallerAuth = {
  userId: string | null;
  /** Lowercased, verified email addresses of the signed-in user. Empty when signed out. */
  verifiedEmails: () => Promise<string[]>;
};

// A type, not an interface: @hono/trpc-server needs a Record<string, unknown>,
// which an interface is not. Over HTTP, @hono/trpc-server also adds `env` to
// ctx, but the SSR path does not, so procedures use `ctx.services` and never
// `ctx.env`.
export type Context = {
  /** Lowercased entries of the comma-separated ADMIN_EMAILS secret. Empty means nobody is an admin. */
  adminEmails: string[];
  auth: CallerAuth;
  /** Every service, built from the bindings per request (cms/wiring.ts). */
  services: { cms: CmsServices };
  /** Signed-in user, or null for anonymous callers. */
  userId: string | null;
};

const createContext = (
  bindings: Env,
  userId: string | null,
  request: Request | null
): Context => {
  let emails: Promise<string[]> | undefined;
  return {
    adminEmails: parseAdminEmails(bindings.ADMIN_EMAILS),
    auth: {
      userId,
      // Memoised: one Clerk lookup per request however many checks run.
      verifiedEmails: () => {
        emails ??= lookupVerifiedEmails(bindings, userId);
        return emails;
      },
    },
    services: { cms: cmsServices(bindings, { author: userId, request }) },
    userId,
  };
};

/**
 * Calls over HTTP: /api/trpc, mounted in src/server.ts after @clerk/hono's
 * clerkMiddleware(), which is what getAuth(c) reads.
 */
export const createHonoContext = (
  c: HonoContext<{ Bindings: Env }>
): Promise<Context> =>
  Promise.resolve(createContext(c.env, getAuth(c)?.userId ?? null, c.req.raw));

/**
 * In-process calls from route loaders during SSR (src/integrations/trpc).
 * auth() reads the session the Clerk request middleware in src/start.ts set.
 */
export const createSsrContext = async (): Promise<Context> => {
  const { userId } = await auth();
  return createContext(env, userId, getRequest());
};
