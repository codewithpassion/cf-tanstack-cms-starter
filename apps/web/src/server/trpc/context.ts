// What every tRPC procedure receives as `ctx`: the services and who is calling.
// `userId` is the Clerk user, or null for anonymous callers; `protectedProcedure`
// rejects the latter. `auth` and `adminEmails` are what `adminProcedure` (init.ts)
// needs to decide whether the caller is an admin.
import { env } from "cloudflare:workers";
import { createClerkClient } from "@clerk/backend";
import { getAuth } from "@clerk/hono";
import { auth } from "@clerk/tanstack-react-start/server";
import type { Context as HonoContext } from "hono";

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
  // TODO(cms-port): the services (pages, site, posts, media, ...) go here.
  services: Record<string, never>;
  /** Signed-in user, or null for anonymous callers. */
  userId: string | null;
};

const parseAdminEmails = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

// The Clerk user's verified addresses, lowercased. Without Clerk keys or a
// signed-in user there are none, so the admin check fails closed.
const lookupVerifiedEmails = async (
  bindings: Env,
  userId: string | null
): Promise<string[]> => {
  if (!(userId && bindings.CLERK_SECRET_KEY)) {
    return [];
  }
  const user = await createClerkClient({
    secretKey: bindings.CLERK_SECRET_KEY,
  }).users.getUser(userId);
  return user.emailAddresses
    .filter((address) => address.verification?.status === "verified")
    .map((address) => address.emailAddress.toLowerCase());
};

const createContext = (bindings: Env, userId: string | null): Context => {
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
    services: {},
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
  Promise.resolve(createContext(c.env, getAuth(c)?.userId ?? null));

/**
 * In-process calls from route loaders during SSR (src/integrations/trpc).
 * auth() reads the session the Clerk request middleware in src/start.ts set.
 */
export const createSsrContext = async (): Promise<Context> => {
  const { userId } = await auth();
  return createContext(env, userId);
};
