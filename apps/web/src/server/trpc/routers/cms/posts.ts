import { adminProcedure, router } from "../../init.ts";
import { obj, str, title } from "./input-fields.ts";

/**
 * Blog posts (docs/cms-plan.md §3.8): the /admin/posts list, "New post", and the published posts
 * the editor's canvas shows in `postList` blocks. Admin only; the shaping lives in
 * @repo/services/cms/posts-admin.
 */
export const postsRouter = router({
  /** Every post (archived included), most recently updated first. */
  listPosts: adminProcedure.query(({ ctx }) => ctx.services.cms.posts.list()),

  /** Live slug check for the "New post" dialog: `slug` is the part after `blog/`. */
  checkPostSlug: adminProcedure
    .input(obj({ slug: str("slug", 400) }))
    .query(({ ctx, input }) => ctx.services.cms.posts.checkSlug(input.slug)),

  /** A draft post at `blog/<slug>` with an empty body, the given category and author, dated today. */
  createPost: adminProcedure
    .input(
      obj({
        title: title(),
        // The part after `blog/`; the service adds the prefix.
        slug: str("slug", 400),
        category: str("category", 400).trim(),
        author: str("author", 400).trim(),
      })
    )
    .mutation(({ ctx, input }) => ctx.services.cms.posts.create(input)),

  /** The published posts (KV `posts:index`, newest first), for `postList` blocks on the editor's canvas. */
  publishedPosts: adminProcedure.query(({ ctx }) =>
    ctx.services.cms.posts.published()
  ),
});
