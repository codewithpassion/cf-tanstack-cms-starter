import type { BlockStyle, MergePatch, PageDoc, PostMeta } from "./types";

/**
 * Blog posts: pages with `kind: "post"` at `blog/<slug>`. Zod-free and
 * registry-free: the public blog routes, the post layout, the page service and the editor share it.
 */

/**
 * A published post as `/blog`, the `postList` block and llms.txt list it (KV `posts:index`).
 * Defined here rather than in the page service (as in the source) so the render context can use it
 * without importing server code.
 */
export type PostSummary = {
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  author: string;
  /** Minutes shown: `PostMeta.readingTimeOverride`, else the computed `readingTime`. */
  readingTime: number;
  category: string;
  tags: string[];
  featuredImage?: PostMeta["featuredImage"];
};

/** Words per minute for `post.readingTime` (the Payload blog path used the same figure). */
export const READING_WPM = 200;

/** Block types the post editor offers ("+"). A quote is a blockquote inside rich text. */
export const POST_BLOCK_TYPES = [
  "richText",
  "image",
  "callout",
  "cta",
  "faq",
] as const;

type PostBlockType = (typeof POST_BLOCK_TYPES)[number];

/**
 * Style for a block added to a post: the post layout owns the article column (max-w-3xl and its
 * side padding), so blocks take its full width. Rich text (the article body) adds no spacing of
 * its own, so consecutive text blocks read as one article; images, callouts, FAQs and calls to
 * action get 32px above and below, and the call to action keeps its default side padding (its
 * background reaches the column edges). A merge-patch over the block's default style
 * (`createBlock`): `null` drops the default's tablet and mobile tiers.
 */
export function postBlockStyle(type: string): MergePatch<BlockStyle> {
  let padding: { top: number; bottom: number; x?: number } = {
    top: POST_BLOCK_GAP,
    bottom: POST_BLOCK_GAP,
    x: 0,
  };
  if (type === "richText") {
    padding = { top: 0, bottom: 0, x: 0 };
  } else if (type === "cta") {
    padding = { top: POST_BLOCK_GAP, bottom: POST_BLOCK_GAP };
  }
  return {
    padding: { desktop: padding, tablet: null, mobile: null },
    maxWidth: { desktop: "full", tablet: null, mobile: null },
  };
}

/** Vertical padding (px) of a non-text block in a post. */
export const POST_BLOCK_GAP = 32;

export function isPostBlockType(type: string): type is PostBlockType {
  return (POST_BLOCK_TYPES as readonly string[]).includes(type);
}

/** A post slug: `blog/` and one more segment (`blog/what-is-x`, never `blog/a/b`). */
export const POST_SLUG_RE = /^blog\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPostSlug(slug: string): boolean {
  return POST_SLUG_RE.test(slug);
}

/** The post's title: `post.title`, else the SEO title (posts made before `post.title` existed). */
export function postTitle(doc: Pick<PageDoc, "seo" | "post">): string {
  return doc.post?.title || doc.seo.title;
}

/** Minutes shown for the post: the override when set, else the computed reading time. */
export function postReadingTime(
  post: Pick<PostMeta, "readingTime" | "readingTimeOverride">
): number {
  return post.readingTimeOverride ?? post.readingTime;
}

/** Today in Sydney as YYYY-MM-DD: a new post's date, and the date its first publish gives it. */
export function todayInSydney(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
  }).format(new Date(now));
}

/** `blog/what-is-x` → `what-is-x` (the `$slug` of /blog/$slug). */
export function postSlug(slug: string): string {
  return slug.startsWith("blog/") ? slug.slice("blog/".length) : slug;
}

const WHITESPACE_RE = /\s+/;

type Node = { type?: unknown; text?: unknown; content?: unknown };

/** Plain text of a rich-text node: a paragraph's or heading's text runs join as they render (marks split them mid-word), other nodes with a space. */
function textOf(node: unknown): string {
  const n = node as Node | null;
  if (!n || typeof n !== "object") {
    return "";
  }
  if (typeof n.text === "string") {
    return n.text;
  }
  if (!Array.isArray(n.content)) {
    return "";
  }
  return n.content
    .map(textOf)
    .join(n.type === "paragraph" || n.type === "heading" ? "" : " ");
}

/** Words in the post's rich text blocks (the article body), counted as whitespace-separated runs. */
export function postWordCount(doc: Pick<PageDoc, "blocks">): number {
  let words = 0;
  for (const block of doc.blocks) {
    if (block?._type !== "richText") {
      continue;
    }
    words += textOf((block.props as { body?: unknown } | null)?.body)
      .split(WHITESPACE_RE)
      .filter(Boolean).length;
  }
  return words;
}

/** Minutes to read the post at READING_WPM, rounded up; 0 for a post with no text. */
export function readingTimeOf(doc: Pick<PageDoc, "blocks">): number {
  const words = postWordCount(doc);
  return words ? Math.max(1, Math.ceil(words / READING_WPM)) : 0;
}

/** The document with `post.readingTime` recomputed from its body (computed on every save). Unchanged without `post`. */
export function withReadingTime<T extends PageDoc>(doc: T): T {
  if (!doc.post) {
    return doc;
  }
  const readingTime = readingTimeOf(doc);
  return doc.post.readingTime === readingTime
    ? doc
    : { ...doc, post: { ...doc.post, readingTime } };
}

/** "9 min read"; empty for 0 (no text yet). */
export function formatReadingTime(minutes: number): string {
  return minutes > 0 ? `${minutes} min read` : "";
}

/** A post date ("2026-07-12" or an ISO timestamp) as the blog shows it: "12 July 2026", in Sydney time. */
export function formatPostDate(date: string): string {
  return new Date(date).toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** /blog's filters (`?category=` and `?tag=`), compared case-insensitively. */
export type PostFilter = { category?: string; tag?: string };

type Filterable = { category: string; tags: string[] };

/** The posts matching `filter` (all of them when it's empty), in their order. */
export function filterPosts<T extends Filterable>(
  posts: readonly T[],
  filter: PostFilter
): T[] {
  const category = filter.category?.trim().toLowerCase();
  const tag = filter.tag?.trim().toLowerCase();
  return posts.filter(
    (p) =>
      (!category || p.category.toLowerCase() === category) &&
      (!tag || p.tags.some((t) => t.toLowerCase() === tag))
  );
}

/** Each category once, in order of first appearance (the index is newest first). */
export function postCategories(posts: readonly Filterable[]): string[] {
  return [...new Set(posts.map((p) => p.category).filter(Boolean))];
}
