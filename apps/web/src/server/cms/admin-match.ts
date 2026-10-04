// Pure parts of the admin check; no Cloudflare or Clerk imports, so tests can load them.

/** Lowercased entries of the comma-separated ADMIN_EMAILS secret. */
export const parseAdminEmails = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

/** The first of the caller's verified addresses that is on the allowlist, or null. */
export const matchAdminEmail = (
  verified: readonly string[],
  allowlist: readonly string[]
): string | null =>
  allowlist.length === 0
    ? null
    : (verified.find((email) => allowlist.includes(email)) ?? null);
