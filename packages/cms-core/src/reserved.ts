/**
 * Slugs owned by code routes (apps/web/src/routes), which the CMS never serves.
 * The CMS serves everything else, including the home page (""). The web app has a test that fails
 * when a route in its generated route tree isn't covered here.
 *
 * `blog/*` stays reserved for pages: posts own it (`checkKind` in pages-service.ts), and the code
 * route `blog.$slug.tsx` serves them from the CMS, so a post at `blog/<slug>` is CMS-servable.
 * Zod-free: the breadcrumb builder and the public read path import it.
 */

/** Static routes that render a page (breadcrumbs may link to these). */
export const STATIC_PAGE_SLUGS: readonly string[] = [
  "blog",
  "login",
  "dev-login",
];

/** Other exact static routes (files). Their dots make them invalid slugs anyway; listed for the drift check. */
const STATIC_FILE_SLUGS: readonly string[] = [
  "sitemap.xml",
  "llms.txt",
  "llms-full.txt",
  "robots.txt",
];

/** Each of these, and everything under it, belongs to code routes. */
export const RESERVED_PREFIXES: readonly string[] = [
  "admin",
  "api",
  "blog",
  "mcp",
  "media",
  "oauth",
  "og-render",
  "og-render-agent",
];

const exact = new Set([...STATIC_PAGE_SLUGS, ...STATIC_FILE_SLUGS]);

export function isReservedSlug(slug: string): boolean {
  return (
    exact.has(slug) ||
    RESERVED_PREFIXES.some((p) => slug === p || slug.startsWith(`${p}/`))
  );
}

/** Whether a CMS page (or post, under `blog/`) published at `slug` is what visitors get there. */
export function isCmsServable(slug: string): boolean {
  return slug.startsWith("blog/") || !isReservedSlug(slug);
}

/** A static page (not whether a CMS page is live there). */
export function isStaticPage(slug: string): boolean {
  return STATIC_PAGE_SLUGS.includes(slug);
}
