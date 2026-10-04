import type { PageKind } from "./types";

/** One published page or post, as the sitemap and llms.txt builders list it. */
export type PageSummary = {
  slug: string;
  kind: PageKind;
  title: string;
  description: string;
  /** When the live revision was published. */
  updatedAt: string;
  /** A post's "updated" date, else its publish date (the sitemap's lastmod; `updatedAt` otherwise). */
  lastmod?: string;
  index: boolean;
  sitemapInclude: boolean;
  llmsInclude: boolean;
  llmsSummary?: string;
};
