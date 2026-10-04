import { describe, expect, it } from "bun:test";
import { createBlock } from "@repo/cms-core/blocks/registry";
import { block, doc, post, seo } from "@repo/cms-core/ops/test-docs";
import { postBlockStyle } from "@repo/cms-core/posts";
import { richTextFromString } from "@repo/cms-core/richtext/schema";
import type { PageDoc } from "@repo/cms-core/types";
import { renderToStaticMarkup } from "react-dom/server";

import { PageRenderer } from "./render/page-renderer";
import { PostContext } from "./render/post-context";
import { PostLayout } from "./render/post-layout";

// The rendering half of the source's posts.test.tsx; the pure post helpers and the post JSON-LD
// are tested in cms-core (posts.test.ts).

type SamplePost = {
  slug: string;
  title: string;
  description: string;
  author: string;
  datePublished: string;
  tags: string[];
  readingTimeOverride?: number;
  /** A TipTap JSON body, as stored. */
  body: unknown;
  /** The body's text as the article typography shows it (list items get a bullet). */
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
    slug: "getting-started",
    title: "Getting started",
    description: "Lorem ipsum dolor sit amet.",
    author: "Jane Doe",
    datePublished: "2026-09-12",
    tags: ["Guides", "Basics"],
    readingTimeOverride: 9,
    body: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Why it matters" }],
        },
        para("Lorem ipsum dolor sit amet."),
        bullets("First point", "Second point"),
        { type: "blockquote", content: [para("A quote.")] },
      ],
    },
    visible:
      "Why it matters Lorem ipsum dolor sit amet. First point Second point A quote.",
    hasQuote: true,
  },
  {
    slug: "next-steps",
    title: "Next steps: where do you start?",
    description: "Consectetur adipiscing elit.",
    author: "Jane Doe",
    datePublished: "2026-08-01",
    tags: ["Guides"],
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
    visible: "Start small Pick one task. Write it down Share it",
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
      tags: p.tags,
      ...(p.readingTimeOverride && {
        readingTimeOverride: p.readingTimeOverride,
      }),
    }),
  });
}

const [FIRST_POST] = SAMPLE_POSTS as [SamplePost, SamplePost];

const TAG_RE = /<[^>]+>/g;
const SPACE_RE = /\s+/g;
const APOS_RE = /&#x27;/g;
const QUOT_RE = /&quot;/g;
const AMP_RE = /&amp;/g;
const OPACITY_0_RE = /opacity:0/g;

describe("post body rendering", () => {
  it.each(SAMPLE_POSTS.map((p) => [p.slug, p] as const))(
    "%s: the article typography shows exactly the body's text, with bullets",
    (_slug, p) => {
      const html = renderToStaticMarkup(
        <PostContext.Provider value={true}>
          <PageRenderer doc={postDoc(p)} />
        </PostContext.Provider>
      );
      const visible = html
        .replace(TAG_RE, " ")
        .replace(APOS_RE, "'")
        .replace(QUOT_RE, '"')
        .replace(AMP_RE, "&")
        .replace(SPACE_RE, " ")
        .trim();
      expect(visible).toBe(p.visible);
      // The article classes for headings, paragraphs and the quote.
      expect(html).toContain(
        'class="font-heading font-semibold tracking-tight text-2xl md:text-3xl'
      );
      expect(html).toContain("text-lg leading-relaxed mb-6");
      if (p.hasQuote) {
        expect(html).toContain(
          "bg-muted pl-6 pr-4 py-4 my-8 border-l-4 border-primary"
        );
      }
    }
  );

  it("outside a post, rich text keeps the page look", () => {
    const html = renderToStaticMarkup(
      <PageRenderer doc={postDoc(FIRST_POST)} />
    );
    expect(html).not.toContain("size-1.5");
    expect(html).toContain("list-disc");
  });
});

describe("post layout", () => {
  const render = (d: PageDoc) =>
    renderToStaticMarkup(
      <PostLayout doc={d} post={d.post ?? post()}>
        <PageRenderer doc={d} />
      </PostLayout>
    );

  it("shows post.title as the H1 and the reading time override (9 min read)", () => {
    const html = render(postDoc(FIRST_POST));
    expect(html).toContain(`>${FIRST_POST.title}</h1>`);
    expect(html).toContain(">9 min read<");
    expect(html).not.toContain(`${FIRST_POST.title} | SEO`);
  });

  it("links back to the blog and to each tag's filtered index", () => {
    const html = render(postDoc(FIRST_POST));
    expect(html).toContain('href="/blog"');
    expect(html).toContain('href="/blog?tag=Guides"');
  });

  it("blocks inside a post don't fade in again (the article column already does)", () => {
    const d = postDoc(FIRST_POST);
    const withCallout: PageDoc = {
      ...d,
      blocks: [
        ...d.blocks,
        createBlock("callout", {
          _key: "c",
          props: { heading: "Note", body: richTextFromString("x") },
          style: postBlockStyle("callout"),
        }),
      ],
    };
    const html = render(withCallout);
    expect(html).toContain("Note");
    // The layout's own animated wrappers (header, body, tags) and nothing more inside the blocks.
    const faded = (h: string) => h.match(OPACITY_0_RE)?.length ?? 0;
    expect(faded(html)).toBe(faded(render(d)));
    expect(faded(html)).toBe(3);
  });
});
