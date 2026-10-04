import { z } from "zod";
import type { PostSummary } from "../posts";
import { defineBlock } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().max(200).optional(),
  /** Only posts in this category (exact name, as on the post); all posts when empty. */
  category: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(12),
  /** Label of a link to /blog under the cards; no link when empty. */
  viewAllLabel: z.string().max(60).optional(),
});

type Props = z.output<typeof schema>;

/** The newest `limit` published posts (in `category`, when set). `posts` is `posts:index`, newest first. The web registry's `hiddenWhen` uses it too. */
export function selectPosts(
  posts: readonly PostSummary[],
  props: Pick<Props, "category" | "limit">
): PostSummary[] {
  const category = props.category?.trim().toLowerCase();
  return posts
    .filter((p) => !category || p.category.toLowerCase() === category)
    .slice(0, props.limit);
}

export const postList = defineBlock({
  type: "postList",
  version: 1,
  label: "Post list",
  icon: "newspaper",
  category: "content",
  schema,
  defaults: (): Props => ({
    eyebrow: "Blog",
    heading: "Latest insights",
    limit: 3,
    viewAllLabel: "All articles",
  }),
  defaultStyle: {
    padding: {
      desktop: { top: 80, bottom: 80 },
      mobile: { top: 64, bottom: 64 },
    },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    items: ["hide"],
    link: ["align", "hide"],
  },
  onCard: ["items"],
  ai: "The newest published blog posts as cards (title, category, reading time, excerpt, date), linking to each post. `limit` posts (1-12); set `category` to a post category's exact name to show only that category. Use on the home page or a section page to surface recent writing; the posts update themselves when new ones are published.",
});
