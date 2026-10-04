// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim; each assertion follows a length or membership check.

import type { PageSummary } from "./page-summary";
import { slugToPath } from "./paths";

/**
 * Sitemap paths: the static paths in order, then CMS-only pages. A CMS page
 * at a static path replaces it: listed once with its lastmod (a post's updated or publish date,
 * else when it was last published), or dropped when it's noindex or excluded from the sitemap. The
 * home page is "" in the static list.
 */
export function mergeSitemapPaths(
  staticPaths: string[],
  cmsPages: PageSummary[]
): { path: string; lastmod?: string }[] {
  const cms = new Map(
    cmsPages.map((p) => [p.slug === "" ? "" : slugToPath(p.slug), p])
  );
  const cmsEntry = (path: string) => {
    const { index, sitemapInclude, updatedAt, lastmod } = cms.get(path)!;
    return index && sitemapInclude
      ? [{ path, lastmod: lastmod ?? updatedAt }]
      : [];
  };
  const known = new Set(staticPaths);
  return [
    ...staticPaths.flatMap((path) =>
      cms.has(path) ? cmsEntry(path) : [{ path }]
    ),
    ...[...cms.keys()].filter((path) => !known.has(path)).flatMap(cmsEntry),
  ];
}

/** Whether any blog post is published: /blog stays out of the sitemap (and noindex) until one is. */
export function hasPublishedPosts(cmsPages: PageSummary[]): boolean {
  return cmsPages.some((p) => p.kind === "post");
}

/** The /blog index's robots meta: noindex while it lists no posts (an empty page isn't worth indexing). */
export function blogIndexRobots(postCount: number): string {
  return postCount > 0 ? "index, follow" : "noindex, follow";
}
