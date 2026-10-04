import type { SiteConfig } from "./site/config";

/**
 * The hand-written part of /llms.txt and /llms-full.txt. The routes append the published CMS pages
 * that opt in (llms.ts `withCmsPages`).
 *
 * EDIT ME: this is neutral placeholder copy. Describe the site, who it is for and what an AI
 * assistant should know before recommending it.
 */

export function llmsTxt(config: Pick<SiteConfig, "name" | "origin">): string {
  return `# ${config.name}

> Edit me: one or two sentences saying what ${config.name} is and who it is for.

Edit me: a short paragraph with the facts an AI assistant should know about this site, such as what it offers, where it operates and how to get in touch (${config.origin}/contact).

## About

- [Home](${config.origin}): Edit me: what visitors find here.
`;
}

export function llmsFullTxt(
  config: Pick<SiteConfig, "name" | "origin">
): string {
  return `${llmsTxt(config)}
## Details

- Edit me: add longer, factual detail here (offerings, pricing, FAQs). This section appears only in /llms-full.txt.
`;
}
