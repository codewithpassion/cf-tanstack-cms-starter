// The admin check, shared by `adminProcedure` (trpc/init.ts) and the raw routes
// (`assertAdminApi`), so the two cannot drift apart. It fails closed: an empty list, missing
// Clerk keys or an unverified address mean no admin.
import { env } from "cloudflare:workers";
import { createClerkClient } from "@clerk/backend";
import { auth } from "@clerk/tanstack-react-start/server";

import { matchAdminEmail, parseAdminEmails } from "./admin-match.ts";

/** The Clerk user's verified addresses, lowercased. None without Clerk keys or a user. */
export const lookupVerifiedEmails = async (
  bindings: Pick<Env, "CLERK_SECRET_KEY">,
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

export type AdminCheck =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403 | 503; message: string };

/** For raw routes, which have no tRPC context: reads Clerk's state from the request middleware. */
export const checkAdmin = async (): Promise<AdminCheck> => {
  if (!(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY)) {
    return {
      ok: false,
      status: 503,
      message: "Admin area is not configured on this environment.",
    };
  }
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, status: 401, message: "Sign in required." };
  }
  const allowlist = parseAdminEmails(env.ADMIN_EMAILS);
  if (allowlist.length === 0) {
    return {
      ok: false,
      status: 503,
      message:
        "Admin access is not configured on this environment (ADMIN_EMAILS is empty).",
    };
  }
  const email = matchAdminEmail(
    await lookupVerifiedEmails(env, userId),
    allowlist
  );
  return email
    ? { ok: true, userId, email }
    : {
        ok: false,
        status: 403,
        message: "Your account does not have admin access.",
      };
};

/**
 * For raw routes (`/admin/api/*`): resolves to the user, or throws a JSON `Response` (401 signed
 * out, 403 off the allowlist, 503 unconfigured) the handler returns as is. Call it before reading
 * the body.
 */
export const assertAdminApi = async (
  _request: Request
): Promise<{ userId: string; email: string }> => {
  const check = await checkAdmin();
  if (check.ok) {
    return { userId: check.userId, email: check.email };
  }
  throw Response.json(
    { ok: false, message: check.message },
    { status: check.status }
  );
};
