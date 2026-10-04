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
              className="inline-flex items-center gap-2 text-accent font-sans text-xs uppercase tracking-wider mb-8 hover:text-white transition-colors"
            >
              &larr; Back to Blog
            </a>

            <div className="flex items-center gap-3 mb-6">
              <span className="text-accent font-sans text-xs uppercase tracking-wider border border-accent/30 px-2 py-1">
                {post.category}
              </span>
              {readingTime && (
                <span className="text-white/40 font-sans text-xs">
                  {readingTime}
                </span>
              )}
            </div>

            <h1 className="font-heading font-black text-3xl md:text-5xl text-primary mb-6 leading-tight">
              {postTitle(doc)}
            </h1>
            <div className="w-24 h-1 bg-gradient-to-r from-primary to-accent mb-8" />

            <div className="flex items-center gap-4 text-white/50 font-sans text-sm">
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
              className="w-full cyber-border object-cover"
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
              className="mt-12 pt-8 border-t border-white/10"
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
                    className="text-white/50 font-sans text-xs border border-white/20 px-3 py-1 hover:text-white hover:border-white/40 transition-colors"
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
