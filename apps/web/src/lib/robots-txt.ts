import type { SiteConfig } from "@repo/cms-core/site/config";

/** Served at /robots.txt (src/routes/robots[.]txt.tsx): crawl everything public, never admin or render targets. */
export const robotsTxt = (
  config: Pick<SiteConfig, "origin">
): string => `User-agent: *
Allow: /
Disallow: /admin
Disallow: /og-render
Disallow: /og-render-agent
Disallow: /api

Sitemap: ${config.origin}/sitemap.xml
`;
