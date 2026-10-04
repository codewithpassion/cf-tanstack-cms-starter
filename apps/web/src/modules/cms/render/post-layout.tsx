import { mediaUrl } from "@repo/cms-core/media";
import {
  formatPostDate,
  formatReadingTime,
  postReadingTime,
  postTitle,
} from "@repo/cms-core/posts";
import type { PageDoc, PostMeta } from "@repo/cms-core/types";
import { type HTMLMotionProps, motion } from "framer-motion";
import type { ReactNode } from "react";

import { useEditMode } from "./edit-mode";
import { PostContext } from "./post-context";

/**
 * A blog post's article column (docs/cms-plan.md §3.8), with the markup and classes of the
 * blog's article page: the header (back link, category, reading time, title,
 * author and date), the featured image, the body (`children`: the post's blocks, rendered with the
 * article typography) and the tags. The public page (post-article.tsx) puts the site chrome
 * around it; the editor's canvas uses it as is, so posts are edited at article width.
 */
export function PostLayout({
  doc,
  post,
  children,
}: {
  doc: PageDoc;
  post: PostMeta;
  children: ReactNode;
}) {
  const readingTime = formatReadingTime(postReadingTime(post));
  return (
    <>
      <section className="relative pt-32 pb-12">
        <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <Animated
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8 }}
          >
            <a
              href="/blog"
              className="inline-flex items-center gap-2 text-primary font-sans text-xs mb-8 hover:text-foreground transition-colors"
            >
              &larr; Back to Blog
            </a>

            <div className="flex items-center gap-3 mb-6">
              <span className="text-primary font-sans text-xs rounded-full border border-border bg-muted px-2.5 py-0.5">
                {post.category}
              </span>
              {readingTime && (
                <span className="text-muted-foreground font-sans text-xs">
                  {readingTime}
                </span>
              )}
            </div>

            <h1 className="font-heading font-semibold tracking-tight text-3xl md:text-5xl text-foreground mb-6 leading-tight text-balance">
              {postTitle(doc)}
            </h1>
            <div className="w-12 h-1 rounded-full bg-primary mb-8" />

            <div className="flex items-center gap-4 text-muted-foreground font-sans text-sm">
              <span>{post.author}</span>
              <span>·</span>
              <span>{formatPostDate(post.publishedAt)}</span>
            </div>
          </Animated>
        </div>
      </section>

      {!!post.featuredImage && (
        <section className="relative pb-4">
          <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            {/* biome-ignore lint/correctness/useImageSize: a media-library image of unknown size, full column width. */}
            <img
              src={mediaUrl(post.featuredImage.mediaId)}
              alt={post.featuredImage.alt}
              className="w-full rounded-lg border border-border object-cover"
            />
          </div>
        </section>
      )}

      <article className="relative pb-16">
        <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <Animated
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <PostContext.Provider value={true}>{children}</PostContext.Provider>
          </Animated>

          {post.tags.length > 0 && (
            <Animated
              className="mt-12 pt-8 border-t border-border"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
              viewport={{ once: true }}
            >
              <div className="flex flex-wrap gap-2">
                {post.tags.map((tag) => (
                  <a
                    key={tag}
                    href={`/blog?tag=${encodeURIComponent(tag)}`}
                    className="text-muted-foreground font-sans text-xs border border-border px-3 py-1 hover:text-foreground hover:border-foreground/30 transition-colors"
                  >
                    {tag}
                  </a>
                ))}
              </div>
            </Animated>
          )}
        </div>
      </article>
    </>
  );
}

/** framer-motion's entrance on the public site; a plain div in the editor, so the canvas never shows hidden content. */
function Animated({
  className,
  children,
  ...motionProps
}: HTMLMotionProps<"div"> & { children: ReactNode }) {
  const { editing } = useEditMode();
  if (editing) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div className={className} {...motionProps}>
      {children}
    </motion.div>
  );
}
