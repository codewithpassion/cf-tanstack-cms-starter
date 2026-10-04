import type { PageSummary } from "@repo/cms-core/page-summary";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { hasPublishedPosts, mergeSitemapPaths } from "@repo/cms-core/sitemap";

/**
 * /sitemap.xml (routes/sitemap[.]xml.tsx): /blog once a post is published, then the published CMS
 * pages and posts from KV `pages:index` (merged by cms-core `mergeSitemapPaths`: noindex and
 * sitemap-excluded pages are left out). The home page is listed once a CMS home page is published.
 */

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;

const xmlEscape = (s: string): string =>
  s.replace(AMP_RE, "&amp;").replace(LT_RE, "&lt;").replace(GT_RE, "&gt;");

const urlEntry = (origin: string, path: string, lastmod?: string): string => {
  const loc = xmlEscape(`${origin}${path}`);
  const mod = lastmod ? `\n    <lastmod>${lastmod.slice(0, 10)}</lastmod>` : "";
  return `  <url>\n    <loc>${loc}</loc>${mod}\n  </url>`;
};

export const sitemapXml = (
  config: Pick<SiteConfig, "origin">,
  cmsPages: PageSummary[]
): string => {
  // /blog is listed once a post is published; until then it is an empty, noindexed page.
  const staticPaths = hasPublishedPosts(cmsPages) ? ["/blog"] : [];
  const entries = mergeSitemapPaths(staticPaths, cmsPages).map((e) =>
    urlEntry(config.origin, e.path, e.lastmod)
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join(
    "\n"
  )}\n</urlset>`;
};

export const sitemapResponse = (
  config: Pick<SiteConfig, "origin">,
  cmsPages: PageSummary[]
): Response =>
  new Response(sitemapXml(config, cmsPages), {
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "public, max-age=3600",
    },
  });
