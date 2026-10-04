import { describe, expect, it } from "bun:test";
import { createBlock } from "./blocks/registry";
import { block, doc, post, seo } from "./ops/test-docs";
import {
  filterPosts,
  formatPostDate,
  formatReadingTime,
  isPostSlug,
  POST_BLOCK_GAP,
  POST_BLOCK_TYPES,
  postBlockStyle,
  postCategories,
  postReadingTime,
  postSlug,
  postTitle,
  postWordCount,
  readingTimeOf,
  todayInSydney,
  withReadingTime,
} from "./posts";
import { buildJsonLd } from "./render/page-json-ld";
import { richTextFromString } from "./richtext/schema";
import { TEST_CONFIG } from "./test-fixtures";
import type { PageDoc } from "./types";
import { validatePageDoc } from "./validate";

// The suites that render posts ("post body rendering", "post layout") need React and live in the
// web app; this file keeps the pure ones. "post JSON-LD" runs over two sample posts (SAMPLE_POSTS).
describe("reading time", () => {
  it("counts the words of richText blocks only; a mark boundary doesn't split a word", () => {
    const body = {
      content: [
        {
          attrs: { level: 2 },
          content: [{ text: "Two words", type: "text" }],
          type: "heading",
        },
        {
          content: [
            { text: "bo", type: "text" },
            { marks: [{ type: "bold" }], text: "ld word", type: "text" },
          ],
          type: "paragraph",
        },
        {
          content: [
            {
              content: [
                {
                  content: [{ text: "item", type: "text" }],
                  type: "paragraph",
                },
              ],
              type: "listItem",
            },
          ],
          type: "bulletList",
        },
      ],
      type: "doc",
    };
    const d = doc([
      block("a", "richText", { body }),
      block("b", "cta", { heading: "not counted" }),
    ]);
    expect(postWordCount(d)).toBe(5);
    expect(readingTimeOf(d)).toBe(1);
    expect(readingTimeOf(doc([]))).toBe(0);
  });

  it("rounds up at 200 words a minute", () => {
    const words = (n: number) =>
      doc([
        block("a", "richText", {
          body: richTextFromString(new Array(n).fill("w").join(" ")),
        }),
      ]);
    expect([200, 201, 400].map((n) => readingTimeOf(words(n)))).toEqual([
      1, 2, 2,
    ]);
  });

  it("withReadingTime only touches posts", () => {
    const page = doc([]);
    expect(withReadingTime(page)).toBe(page);
    expect(
      withReadingTime(doc([], { post: post({ readingTime: 7 }) })).post
        ?.readingTime
    ).toBe(0);
  });

  it("formats as the blog shows it", () => {
    expect(formatReadingTime(9)).toBe("9 min read");
    expect(formatReadingTime(0)).toBe("");
    expect(formatPostDate("2026-07-12")).toBe("12 July 2026");
    expect(formatPostDate("2026-03-19T23:30:00.000Z")).toBe("20 March 2026"); // Sydney time
    expect(postSlug("blog/x-y")).toBe("x-y");
  });
});

describe("posts index filters", () => {
  const posts = [
    { category: "AI Tools", slug: "blog/c", tags: ["Claude", "Agents"] },
    { category: "AI Strategy", slug: "blog/b", tags: ["Teams"] },
    { category: "AI Tools", slug: "blog/a", tags: ["teams"] },
  ];

  it("filters by category and tag, case-insensitively, keeping the order", () => {
    expect(filterPosts(posts, {}).map((p) => p.slug)).toEqual([
      "blog/c",
      "blog/b",
      "blog/a",
    ]);
    expect(
      filterPosts(posts, { category: "ai tools" }).map((p) => p.slug)
    ).toEqual(["blog/c", "blog/a"]);
    expect(filterPosts(posts, { tag: "TEAMS" }).map((p) => p.slug)).toEqual([
      "blog/b",
      "blog/a",
    ]);
    expect(
      filterPosts(posts, { category: "AI Tools", tag: "teams" }).map(
        (p) => p.slug
      )
    ).toEqual(["blog/a"]);
    expect(filterPosts(posts, { tag: "nope" })).toEqual([]);
  });

  it("lists each category once, newest post's first", () => {
    expect(postCategories(posts)).toEqual(["AI Tools", "AI Strategy"]);
  });
});

describe("post title, reading time and slugs", () => {
  it("the post's title wins over the SEO title; reading time override wins over the computed one", () => {
    // The source used the first legacy blog post; any post whose title differs from its SEO title does.
    const d = doc([], {
      post: post({ title: "Post title" }),
      seo: { ...doc().seo, title: "SEO title" },
    });
    expect(postTitle(d)).toBe("Post title");
    expect(
      postTitle({
        ...d,
        post: { ...post({ title: "Post title" }), title: undefined },
      })
    ).toBe(d.seo.title);
    expect(
      postTitle({
        ...d,
        post: { ...post({ title: "Post title" }), title: "Short" },
      })
    ).toBe("Short");
    expect(postReadingTime({ readingTime: 5, readingTimeOverride: 9 })).toBe(9);
    expect(postReadingTime({ readingTime: 5 })).toBe(5);
  });

  it("a post slug is blog/ and exactly one segment", () => {
    expect(["blog/a", "blog/what-is-x"].map(isPostSlug)).toEqual([true, true]);
    expect(
      ["blog", "blog/", "blog/a/b", "news/a", "blog/A"].map(isPostSlug)
    ).toEqual([false, false, false, false, false]);
  });

  it("today in Sydney", () => {
    expect(todayInSydney(Date.parse("2026-10-01T14:30:00Z"))).toBe(
      "2026-10-02"
    );
    expect(todayInSydney(Date.parse("2026-10-01T12:00:00Z"))).toBe(
      "2026-10-01"
    );
  });

  it("post blocks: rich text adds no spacing; other blocks 32px above and below; the cta keeps its side padding", () => {
    expect(postBlockStyle("richText").padding).toEqual({
      desktop: { bottom: 0, top: 0, x: 0 },
      mobile: null,
      tablet: null,
    });
    for (const type of ["image", "callout", "faq"]) {
      expect(postBlockStyle(type).padding).toEqual({
        desktop: { bottom: POST_BLOCK_GAP, top: POST_BLOCK_GAP, x: 0 },
        mobile: null,
        tablet: null,
      });
    }
    expect(postBlockStyle("cta").padding).toEqual({
      desktop: { bottom: POST_BLOCK_GAP, top: POST_BLOCK_GAP },
      mobile: null,
      tablet: null,
    });
    const cta = createBlock("cta", { _key: "c", style: postBlockStyle("cta") });
    // The default's side padding stays (x unset → the block default), its mobile tier is dropped.
    expect(cta.style?.padding).toEqual({
      desktop: { bottom: POST_BLOCK_GAP, top: POST_BLOCK_GAP },
    });
    for (const type of POST_BLOCK_TYPES) {
      expect(
        validatePageDoc(
          doc([createBlock(type, { _key: "k", style: postBlockStyle(type) })])
        ).ok
      ).toBe(true);
    }
  });
});

type SamplePost = {
  slug: string;
  title: string;
  description: string;
  author: string;
  datePublished: string;
  dateModified?: string;
  tags: string[];
  readingTimeOverride?: number;
  /** A TipTap JSON body, as stored. */
  body: unknown;
  /** The body's text as the article typography shows it (list items get a ► bullet). */
  visible: string;
  hasQuote: boolean;
};

const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const bullets = (...items: string[]) => ({
  type: "bulletList",
  content: items.map((text) => ({ type: "listItem", content: [para(text)] })),
});

/** Two posts covering every node the article typography styles: heading, paragraph, list, quote. */
const SAMPLE_POSTS: SamplePost[] = [
  {
    slug: "claude-code-in-a-day",
    title: "Claude Code in a day",
    description: "What a one-day training course covers.",
    author: "Jane Doe",
    datePublished: "2026-09-12",
    dateModified: "2026-09-20",
    tags: ["Claude Code", "Training"],
    readingTimeOverride: 9,
    body: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Why it matters" }],
        },
        para("Teams ship faster."),
        bullets("First point", "Second point"),
        { type: "blockquote", content: [para("A quote.")] },
      ],
    },
    visible:
      "Why it matters Teams ship faster. ► First point ► Second point A quote.",
    hasQuote: true,
  },
  {
    slug: "prompting-for-teams",
    title: "Prompting for teams: where do you start?",
    description: "A first prompt library for a team.",
    author: "Jane Doe",
    datePublished: "2026-08-01",
    tags: ["Prompting"],
    body: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Start small" }],
        },
        para("Pick one task."),
        bullets("Write it down", "Share it"),
      ],
    },
    visible: "Start small Pick one task. ► Write it down ► Share it",
    hasQuote: false,
  },
];

/** A sample post as the CMS stores it: the body in one richText block, the SEO title different from the post title. */
function postDoc(p: SamplePost): PageDoc {
  return doc([block("body", "richText", { body: p.body })], {
    seo: seo({
      title: `${p.title} | SEO`,
      description: p.description,
      slug: `blog/${p.slug}`,
      schema: { pageType: "Article" },
    }),
    post: post({
      title: p.title,
      excerpt: p.description,
      author: p.author,
      publishedAt: p.datePublished,
      ...(p.dateModified && { modifiedAt: p.dateModified }),
      tags: p.tags,
      ...(p.readingTimeOverride && {
        readingTimeOverride: p.readingTimeOverride,
      }),
    }),
  });
}

/** The Article and BreadcrumbList nodes the hand-written blog route emitted for a post. */
function expectedJsonLd(p: SamplePost) {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: p.title,
      description: p.description,
      author: { "@type": "Person", name: p.author },
      publisher: {
        "@type": "Organization",
        name: TEST_CONFIG.name,
        url: TEST_CONFIG.origin,
      },
      datePublished: p.datePublished,
      dateModified: p.dateModified ?? p.datePublished,
      url: `${TEST_CONFIG.origin}/blog/${p.slug}`,
      keywords: p.tags.join(", "),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: TEST_CONFIG.origin,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Blog",
          item: `${TEST_CONFIG.origin}/blog`,
        },
        {
          "@type": "ListItem",
          position: 3,
          name: p.title,
          item: `${TEST_CONFIG.origin}/blog/${p.slug}`,
        },
      ],
    },
  ];
}

const byType = (nodes: Record<string, unknown>[]) =>
  [...nodes].sort((a, b) =>
    String(a["@type"]).localeCompare(String(b["@type"]))
  );

const [FIRST_POST] = SAMPLE_POSTS as [SamplePost, SamplePost];
const FEATURED_ID = "a".repeat(16);

describe("post JSON-LD", () => {
  it.each(SAMPLE_POSTS.map((p) => [p.slug, p] as const))(
    "%s: emits the Article and BreadcrumbList nodes",
    (_slug, p) => {
      expect(
        byType(buildJsonLd(postDoc(p), `/blog/${p.slug}`, TEST_CONFIG))
      ).toEqual(byType(expectedJsonLd(p)));
    }
  );

  it("adds the featured image, the updated date, and drops empty keywords", () => {
    const d = postDoc(FIRST_POST);
    d.post = {
      ...post(),
      ...d.post,
      featuredImage: { mediaId: FEATURED_ID, alt: "Alt" },
      modifiedAt: "2026-10-01",
      tags: [],
    };
    const article = buildJsonLd(
      d,
      `/blog/${FIRST_POST.slug}`,
      TEST_CONFIG
    ).find((n) => n["@type"] === "Article");
    expect(article?.image).toBe(`${TEST_CONFIG.origin}/media/${FEATURED_ID}`);
    expect(article?.dateModified).toBe("2026-10-01");
    expect(article).not.toHaveProperty("keywords");
    expect(article).not.toHaveProperty("name");
  });
});
