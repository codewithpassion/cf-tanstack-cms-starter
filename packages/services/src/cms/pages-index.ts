import type { PostSummary } from "@repo/cms-core/posts";
import { isCmsServable } from "@repo/cms-core/reserved";

import type { PageSummary } from "./pages-service";

/**
 * Live CMS pages at CMS-servable paths (app/cms/reserved.ts), from KV `pages:index`, which publish
 * and take-down rebuild. For the sitemap, llms.txt and breadcrumbs: no D1 on the request path. On
 * a KV failure or an unreadable index this logs and returns no pages, so those fall back to their
 * static content.
 */
export async function readPagesIndex(kv: {
  get: (key: string) => Promise<string | null>;
}): Promise<PageSummary[]> {
  try {
    const raw = await kv.get("pages:index");
    if (raw === null) {
      return [];
    }
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) {
      throw new Error("pages:index is not an array");
    }
    return (entries as PageSummary[]).filter((e) => isCmsServable(e.slug));
  } catch (err) {
    console.error("readPagesIndex: could not read pages:index", err);
    return [];
  }
}

/**
 * Published posts from KV `posts:index` (newest first), which publish and take-down rebuild, for
 * /blog. On a KV failure or an unreadable index this logs and returns no posts.
 */
export async function readPostsIndex(kv: {
  get: (key: string) => Promise<string | null>;
}): Promise<PostSummary[]> {
  try {
    const raw = await kv.get("posts:index");
    return raw === null ? [] : parsePostsIndex(raw);
  } catch (err) {
    console.error("readPostsIndex: could not read posts:index", err);
    return [];
  }
}

/** The `posts:index` value as a list; throws when it isn't one. */
export function parsePostsIndex(raw: string): PostSummary[] {
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("posts:index is not an array");
  }
  return entries as PostSummary[];
}
