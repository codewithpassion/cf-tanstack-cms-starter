// Turns a tRPC UNAUTHORIZED into navigation to `/login?redirect_url=<path>` (decision D8).
// The admin procedures throw UNAUTHORIZED for a signed-out caller and FORBIDDEN for a signed-in
// non-admin; only the first means "sign in", so only it redirects. `/login` honours
// `redirect_url` through `safeRedirectPath` (src/lib/sign-in-target.ts).
//
// In a route loader / beforeLoad (server or client):
//   const data = await redirectOnUnauthorized(
//     getTrpc().cms.pages.listPages.query(),
//     location.href
//   );
// In a component, on a failed query or mutation:
//   onError: (error) => { if (isUnauthorized(error)) { goToLogin(window.location.pathname + window.location.search); } }

import { redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";

const UNAUTHORIZED = "UNAUTHORIZED";

/** True for a tRPC UNAUTHORIZED, from the HTTP link, the in-process SSR link or a caller. */
export const isUnauthorized = (error: unknown): boolean => {
  if (error instanceof TRPCClientError) {
    return (
      (error.data as { code?: unknown } | null | undefined)?.code ===
      UNAUTHORIZED
    );
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNAUTHORIZED
  );
};

/** `/login?redirect_url=<path>`: where a signed-out caller goes, and back to `path` afterwards. */
export const loginHref = (returnTo: string): string =>
  `/login?redirect_url=${encodeURIComponent(returnTo)}`;

/**
 * For route loaders: awaits `call` and, when it fails with UNAUTHORIZED, throws a TanStack
 * redirect to the login page. Other errors pass through unchanged.
 */
export const redirectOnUnauthorized = async <T>(
  call: Promise<T>,
  returnTo: string
): Promise<T> => {
  try {
    return await call;
  } catch (error) {
    if (isUnauthorized(error)) {
      throw redirect({ href: loginHref(returnTo) });
    }
    throw error;
  }
};

/** For client code outside a loader (mutations, event handlers): a full navigation to the login page. */
export const goToLogin = (returnTo: string): void => {
  window.location.assign(loginHref(returnTo));
};
