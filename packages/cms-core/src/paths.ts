/**
 * URL path ↔ page slug. Slugs have no leading or trailing slash; the home page is the empty slug,
 * so "/" ↔ "" and its KV key is `page:`. Zod-free: route loaders import this, and anything they
 * import ends up in every page's entry chunk.
 */

/** Path-like slug, e.g. `services/automation-sprint`; "" is the home page. `slugSchema` uses it. */
export const SLUG_RE =
  /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/;
export const SLUG_MAX = 200;

export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX && SLUG_RE.test(slug);
}

export function slugToPath(slug: string): string {
  return `/${slug}`;
}

/**
 * Maps a request path to a slug. Paths that differ from their canonical form only by case or a
 * trailing slash get `{ redirect }` to it; anything else that isn't a valid slug (`..`, `//`,
 * underscores, encoded characters) is `null`.
 */
const TRAILING_SLASHES_RE = /\/+$/;

export function resolvePath(
  path: string
): { slug: string } | { redirect: string } | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const slug = path.slice(1).replace(TRAILING_SLASHES_RE, "").toLowerCase();
  if (!isValidSlug(slug)) {
    return null;
  }
  const canonical = slugToPath(slug);
  return canonical === path ? { slug } : { redirect: canonical };
}
