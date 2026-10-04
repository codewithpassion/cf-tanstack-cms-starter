import type { SiteConfig } from "./site/config";

/**
 * The `<title>` of every static page a code route renders (reserved.ts `STATIC_PAGE_SLUGS`), so
 * the SEO checks can flag a CMS page that repeats one. Zod-free and React-free like reserved.ts.
 * The web app's static-titles test fails when a route's title changes and this list doesn't.
 *
 * The static pages are the blog index and the sign-in screens; the sign-in screens set no title of
 * their own and show the root's (the site name, `src/routes/__root.tsx`).
 */
export function staticPageTitles(
  config: Pick<SiteConfig, "name">
): Readonly<Record<string, string>> {
  return {
    blog: `Blog | ${config.name}`,
    login: config.name,
    "dev-login": config.name,
  };
}
