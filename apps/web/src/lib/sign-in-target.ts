/** Where a sign-in sends the user when nothing asked for a page: the admin (dev login's main use). */
export const DEFAULT_SIGN_IN_TARGET = "/admin";

// Backslashes and control characters: browsers read "/\host" as "//host".
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point (they are rejected).
const UNSAFE_PATH_CHARS_RE = /[\\\u0000-\u001f\u007f]/;

/**
 * A same-site path to return to after sign-in, from an untrusted `redirect_url` (the admin guard
 * sets it). Only root-relative paths pass, so a crafted link can't send the user off-site after
 * signing in; anything else is `undefined`.
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return;
  }
  return UNSAFE_PATH_CHARS_RE.test(value) ? undefined : value;
}
