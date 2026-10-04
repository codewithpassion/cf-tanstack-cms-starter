/**
 * A conversation's title as plain text: the first message can be Markdown (the "Fix with agent"
 * prompt from /admin/seo has `##` headings and `-` lists), which titles show as one line. Client-safe.
 * Not in the source, which showed the raw Markdown.
 */
const HEADING = /(^|\s)#{1,6}\s+/g;
const LIST_ITEM = /(^|\s)(?:[-*+]|\d+\.)\s+/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS = /\*\*|__|`/g;
const SPACE = /\s+/g;

export function plainTitle(text: string, max = 80): string {
  return text
    .replace(LINK, "$1")
    .replace(HEADING, "$1")
    .replace(LIST_ITEM, "$1")
    .replace(EMPHASIS, "")
    .replace(SPACE, " ")
    .trim()
    .slice(0, max);
}
