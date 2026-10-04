import { newPostDoc } from "@repo/cms-core/new-docs";
import type { PostSummary } from "@repo/cms-core/posts";
import type { PostListRow } from "@repo/db/pages";

import { adminResult } from "./admin-errors";
import type { AdminResult, PageStatus } from "./admin-result";
import { readPostsIndex } from "./pages-index";
import {
  checkSlugAvailable,
  createPage,
  type ServiceDeps,
} from "./pages-service";

/**
 * Blog posts for the admin (docs/cms-plan.md §3.8): the /admin/posts list, "New post", and the
 * published posts the editor's canvas shows in `postList` blocks. The query behind the list is a
 * port (`PostQueries`, `createPageQueries(db)` in `@repo/db/pages`); this shapes its rows.
 */

/** The list query of `createPageQueries`. */
export type PostQueries = { listPosts: () => Promise<PostListRow[]> };

/**
 * A post in /admin/posts. Title, category and date are the LIVE version's for a published post
 * (what visitors see), else the draft's; `draftChanges` says a published post's draft differs from
 * what's live. `slug` is the full slug (`blog/<slug>`).
 */
export type PostListItem = {
  id: string;
  slug: string;
  title: string;
  status: PageStatus;
  /** ISO timestamp of the last save. */
  updatedAt: string;
  category: string;
  /** As stored: "2026-07-12" or an ISO timestamp. */
  publishedAt: string;
  author: string;
  /** Published, with unpublished edits in the draft. */
  draftChanges: boolean;
};

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function toPostListItem(r: PostListRow): PostListItem {
  return {
    id: r.id,
    slug: r.slug,
    title: text(r.title) || text(r.seoTitle) || r.rowTitle,
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
    category: text(r.category),
    publishedAt: text(r.publishedAt),
    author: text(r.author),
    draftChanges: r.draftChanges,
  };
}

/** Every post (archived included), most recently updated first. */
export function listPosts(
  queries: PostQueries
): Promise<AdminResult<{ posts: PostListItem[] }>> {
  return adminResult(async () => ({
    posts: (await queries.listPosts()).map(toPostListItem),
  }));
}

/** Live slug check for the "New post" dialog: `slug` is the part after `blog/`. */
export function checkPostSlug(
  d: ServiceDeps,
  slug: string
): Promise<AdminResult> {
  return adminResult(async () => {
    await checkSlugAvailable(d, "post", `blog/${slug}`);
    return {};
  });
}

export const MAX_POST_TITLE_LENGTH = 200;

/** A draft post at `blog/<slug>` with an empty body to write in, the given category and author, dated today. */
export function createPost(
  d: ServiceDeps,
  input: { title: string; slug: string; category: string; author: string }
): Promise<AdminResult<{ id: string }>> {
  const title = input.title.trim();
  const slug = `blog/${input.slug}`;
  const category = input.category.trim();
  const author = input.author.trim();
  return adminResult(async () => {
    if (title.length > MAX_POST_TITLE_LENGTH) {
      throw new Error(
        `Expected "title" to be at most ${MAX_POST_TITLE_LENGTH} characters`
      );
    }
    await checkSlugAvailable(d, "post", slug);
    const page = await createPage(d, {
      kind: "post",
      slug,
      title,
      doc: newPostDoc({ title, slug, category, author }),
    });
    return { id: page.id };
  });
}

/** The published posts (KV `posts:index`, newest first), for `postList` blocks on the editor's canvas. */
export function publishedPosts(kv: {
  get: (key: string) => Promise<string | null>;
}): Promise<AdminResult<{ posts: PostSummary[] }>> {
  return adminResult(async () => ({ posts: await readPostsIndex(kv) }));
}

/** The posts admin with its ports bound. */
export const createPostsAdmin = (deps: {
  pages: ServiceDeps;
  queries: PostQueries;
  kv: { get: (key: string) => Promise<string | null> };
}) => ({
  list: () => listPosts(deps.queries),
  checkSlug: (slug: string) => checkPostSlug(deps.pages, slug),
  create: (input: Parameters<typeof createPost>[1]) =>
    createPost(deps.pages, input),
  published: () => publishedPosts(deps.kv),
});
