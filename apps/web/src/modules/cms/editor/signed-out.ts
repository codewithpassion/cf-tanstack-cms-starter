import type { AdminError } from "@repo/cms-core/admin-result";

import { isUnauthorized } from "#/integrations/trpc/auth-redirect";

/**
 * Whether a call failed because the admin session ended: the admin procedures answer a signed-out
 * caller with a tRPC UNAUTHORIZED (a signed-in non-admin gets FORBIDDEN, which is not this); a raw
 * admin route or a proxy may answer a plain 401.
 */
export function isSignedOutError(err: unknown): boolean {
  if (err instanceof Response) {
    return err.status === 401;
  }
  return isUnauthorized(err);
}

export const SIGNED_OUT: AdminError = {
  ok: false,
  code: "SIGNED_OUT",
  message: "You were signed out.",
};

/** Runs an admin call; a signed-out failure becomes the `SIGNED_OUT` result the editor store understands. */
export async function signedOutAsResult<T>(
  call: () => Promise<T>
): Promise<T | AdminError> {
  try {
    return await call();
  } catch (err) {
    if (isSignedOutError(err)) {
      return SIGNED_OUT;
    }
    throw err;
  }
}
