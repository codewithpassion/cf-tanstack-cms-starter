import { formatReadingTime, postSlug } from "@repo/cms-core/posts";
import { readPostsIndex } from "@repo/services/cms/pages-index";
import { readSite } from "@repo/services/cms/read-site";
import { z } from "zod";
import { publicProcedure, router } from "../../init.ts";

/** What public route loaders read: no sign-in, KV only (plus D1 for a valid draft preview). */
export const publicRouter = router({
  /**
   * The CMS page at `path`, for the public page loader; routes decide what a redirect or a miss
   * means for them. `preview` is the request's `?_preview=` token: a valid one for this path's page
   * returns its draft (or the staged agent proposal it names), any other is ignored.
   */
  loadCmsPage: publicProcedure
    .input(z.object({ path: z.string(), preview: z.string().optional() }))
    .query(({ ctx, input }) => ctx.services.cms.loadPage(input)),

  /**
   * The published site doc (nav, footer, SEO defaults; docs/cms-plan.md §3.7), one KV read per
   * request, or null for the defaults (nothing published, KV down).
   */
  getRootSite: publicProcedure.query(async ({ ctx }) => ({
    site: await readSite(ctx.services.cms.kv),
  })),

  /** The published posts for /blog (KV `posts:index`, newest first). Missing index: no posts. */
  getBlogIndexData: publicProcedure.query(async ({ ctx }) => {
    const posts = (await readPostsIndex(ctx.services.cms.kv)).map((post) => ({
      slug: postSlug(post.slug),
      title: post.title,
      description: post.excerpt,
      category: post.category,
      tags: post.tags,
      readingTime: formatReadingTime(post.readingTime),
      datePublished: post.publishedAt,
      author: post.author,
    }));
    return { posts };
  }),
});
