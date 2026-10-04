import { type postList, selectPosts } from "@repo/cms-core/blocks/post-list";
import {
  formatPostDate,
  formatReadingTime,
  postSlug,
} from "@repo/cms-core/posts";
import type { z } from "zod";

import { useEditMode } from "../render/edit-mode";
import { useField } from "../render/field";
import { useCmsRender } from "../render/render-context";
import { Reveal } from "../render/reveal";
import {
  accentColor,
  type BlockComponentProps,
  Eyebrow,
  headingWhite,
} from "./ui";

type Props = z.output<typeof postList.schema>;

/** Recent posts as cards (the /blog index's card look), from the posts the route loaded (render-context.tsx). */
export function PostListBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const { editing } = useEditMode();
  const posts = selectPosts(useCmsRender().posts ?? [], props);
  return (
    <>
      {!!(props.eyebrow || props.heading) && (
        <Reveal className="mb-12">
          {!!props.eyebrow && (
            <Eyebrow field={f("eyebrow")}>{props.eyebrow}</Eyebrow>
          )}
          {!!props.heading && (
            <h2
              {...f("heading")}
              className={`font-heading font-bold text-3xl md:text-4xl ${headingWhite}`}
            >
              {props.heading}
            </h2>
          )}
        </Reveal>
      )}
      {posts.length === 0 && editing && (
        <p className="border border-dashed border-white/20 p-6 text-center font-sans text-sm text-white/60">
          No published posts{props.category ? ` in “${props.category}”` : ""}{" "}
          yet. Published posts appear here.
        </p>
      )}
      <div
        {...f("items")}
        className="grid md:grid-cols-2 lg:grid-cols-3 cms-gap"
      >
        {posts.map((post, i) => (
          <Reveal key={post.slug} y={20} delay={i * 0.1}>
            <a
              href={`/blog/${postSlug(post.slug)}`}
              className="cms-card block bg-ink-soft/50 p-8 backdrop-blur-sm hover:bg-ink-soft/70 transition-all group h-full"
            >
              <div className="flex items-center gap-3 mb-4">
                {!!post.category && (
                  <span
                    className={`${accentColor} font-sans text-xs uppercase tracking-wider border border-accent/30 px-2 py-1`}
                  >
                    {post.category}
                  </span>
                )}
                <span className="text-white/40 font-sans text-xs">
                  {formatReadingTime(post.readingTime)}
                </span>
              </div>
              <h3 className="font-heading font-bold text-xl text-primary mb-3 group-hover:text-primary-soft transition-colors leading-tight">
                {post.title}
              </h3>
              <p className="text-white/70 font-sans leading-relaxed mb-6">
                {post.excerpt}
              </p>
              <div className="text-white/40 font-sans text-sm">
                {!!post.author && `${post.author} · `}
                {formatPostDate(post.publishedAt)}
              </div>
            </a>
          </Reveal>
        ))}
      </div>
      {props.viewAllLabel && posts.length > 0 && (
        <div {...f("link")} className="mt-10">
          <a
            href="/blog"
            className={`${accentColor} font-sans text-xs uppercase tracking-wider hover:text-white transition-colors`}
          >
            {props.viewAllLabel} &rarr;
          </a>
        </div>
      )}
    </>
  );
}
