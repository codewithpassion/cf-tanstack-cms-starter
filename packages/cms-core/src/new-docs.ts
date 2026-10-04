import { nanoid } from "nanoid";

import { createBlock } from "./blocks/registry";
import { postBlockStyle, todayIn } from "./posts";
import { richTextFromString } from "./richtext/schema";
import type { PageDoc } from "./types";

/** Starting documents for "New page" and "New post" (admin-fns.ts, posts-fns.ts) and the agent's `create_page`. */

/** A new page: SEO defaults from the title and slug, and a hero with the title as its heading. */
export function newPageDoc(title: string, slug: string): PageDoc {
  return {
    _schema: 1,
    seo: {
      title,
      description: "",
      slug,
      robots: { index: true, follow: true },
      sitemap: { include: true },
      social: {},
      schema: { pageType: "WebPage" },
      llms: { include: true },
    },
    blocks: [
      createBlock("hero", { _key: nanoid(10), props: { heading: title } }),
    ],
  };
}

/**
 * A new post: the title as the post's title and, to start with, its SEO
 * title (the two can differ later), `Article` structured data, listed in llms.txt, and one
 * rich-text block to write in, styled for the post's article column. The share title follows the
 * SEO title (templated, like every CMS page). Reading time is computed on save. Dated today, and
 * re-dated on its first publish unless the date is changed first (`publishedAtAuto`).
 */
export function newPostDoc({
  title,
  slug,
  category,
  author,
  timeZone,
}: {
  title: string;
  slug: string;
  category: string;
  author: string;
  /** IANA zone of "today" (the site's `timeZone`), default UTC. */
  timeZone?: string;
}): PageDoc {
  return {
    _schema: 1,
    seo: {
      title,
      description: "",
      slug,
      robots: { index: true, follow: true },
      sitemap: { include: true },
      social: {},
      schema: { pageType: "Article" },
      llms: { include: true },
    },
    post: {
      title,
      excerpt: "",
      author,
      // Today in the site's zone, as YYYY-MM-DD; the first publish moves it to that day (editor/store.ts).
      publishedAt: todayIn(timeZone),
      category,
      tags: [],
      readingTime: 0,
      publishedAtAuto: true,
    },
    blocks: [
      createBlock("richText", {
        _key: nanoid(10),
        props: { body: richTextFromString("Start writing here.") },
        style: postBlockStyle("richText"),
      }),
    ],
  };
}
