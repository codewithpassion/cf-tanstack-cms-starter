import type { Context } from "hono";

/**
 * Returns a response from a Hono handler without losing its Set-Cookie headers. When middleware
 * already put cookies on `c.res` (`@clerk/hono` does, with the refreshed session after renewing an
 * expired token), Hono replaces the returned response's Set-Cookie with those (`set res` in
 * hono/context), so the handler's own are dropped: the OAuth consent page's binding cookie, for
 * one. Copying them onto `c.res` first keeps both.
 */
export function withHandlerCookies(c: Context, res: Response): Response {
  for (const cookie of res.headers.getSetCookie()) {
    c.res.headers.append("Set-Cookie", cookie);
  }
  return res;
}
