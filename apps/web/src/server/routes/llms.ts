import { llmsResponse, withCmsPages } from "@repo/cms-core/llms";
import { llmsFullTxt, llmsTxt } from "@repo/cms-core/llms-intro";
import type { PageSummary } from "@repo/cms-core/page-summary";
import type { SiteConfig } from "@repo/cms-core/site/config";

/**
 * /llms.txt and /llms-full.txt (routes/llms[.]txt.tsx, routes/llms-full[.]txt.tsx): the
 * hand-written intro (cms-core llms-intro.ts, "edit me" copy) plus the published CMS pages that opt
 * in (`seo.llms.include`), from KV `pages:index`.
 */
export const llmsBody = (
  variant: "llms" | "llms-full",
  config: Pick<SiteConfig, "name" | "origin">,
  cmsPages: PageSummary[]
): string =>
  withCmsPages(
    variant === "llms" ? llmsTxt(config) : llmsFullTxt(config),
    cmsPages,
    config
  );

export const llmsTxtResponse = (
  variant: "llms" | "llms-full",
  config: Pick<SiteConfig, "name" | "origin">,
  cmsPages: PageSummary[]
): Response => llmsResponse(llmsBody(variant, config, cmsPages));
