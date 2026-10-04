import type { PageSummary } from "./page-summary";
import { slugToPath } from "./paths";
import { absoluteUrl } from "./seo/build-head";
import type { SiteConfig } from "./site/config";

/**
 * llms.txt / llms-full.txt: the hand-written file, verbatim, then
 * the published CMS pages that opt in with `seo.llms.include`, and the posts that do, each under
 * their own heading. With none of either the output is the file unchanged.
 */
export function withCmsPages(
  text: string,
  pages: PageSummary[],
  config: Pick<SiteConfig, "origin">
): string {
  const line = (page: PageSummary) => {
    const summary = page.llmsSummary || page.description;
    return `- [${page.title}](${absoluteUrl(config, slugToPath(page.slug))})${summary ? `: ${summary}` : ""}`;
  };
  const listed = pages.filter((page) => page.llmsInclude);
  const sections = [
    ["More Pages", listed.filter((page) => page.kind !== "post")],
    ["Blog Posts", listed.filter((page) => page.kind === "post")],
  ] as const;
  return sections.reduce(
    (out, [heading, entries]) =>
      entries.length
        ? `${out}\n## ${heading}\n\n${entries.map(line).join("\n")}\n`
        : out,
    text
  );
}

export function llmsResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
