import { describe, expect, it } from "bun:test";
import {
  BLOCK_TYPES,
  type BlockOverrides,
  type BlockType,
  createBlock,
} from "@repo/cms-core/blocks/registry";
import { richTextFromString } from "@repo/cms-core/richtext/schema";
import { blockDef, MEDIA_ID, sampleSeo } from "@repo/cms-core/test-fixtures";
import type { Block, PageDoc } from "@repo/cms-core/types";
import { parseBlock, validatePageDoc } from "@repo/cms-core/validate";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";

import { EditModeContext } from "../render/edit-mode";
import { PageRenderer } from "../render/page-renderer";
import { CmsRenderContext } from "../render/render-context";
import { BLOCK_ICONS, getBlock, listBlocks } from "./registry";

const WHITE_ACCENT_SPAN_RE =
  /<span style="color:var\(--color-white\)" class="text-accent">Transform<\/span>/;
const BRACKETED_TAGLINE_RE = /\[<\/span>Tagline<span class="text-primary">\]/;
const SERVICE_CARD_LINK_RE =
  /<a href="\/services" class="[^"]*after:absolute after:inset-0[^"]*">Learn More →<\/a>/;
const CARD_AS_LINK_RE = /<a [^>]*class="cms-card/;
const LIFTED_CONTENT_RE = /class="relative z-10 [^"]*"/;
const HIDDEN_LOGO_COLUMN_RE =
  /<div data-cms-hide-d="" data-cms-collapses="" class="hidden lg:flex lg:w-1\/2/;
const HIDDEN_CALLOUT_BOX_RE =
  /<div data-cms-hide-d="" data-cms-collapses="" class="cms-measure bg-primary\/10/;
const CHECKLIST_EYEBROW_RE =
  /<div data-cms-fs="d t m" style="color:var\(--color-danger\);--cms-e-fs-d:2\.25rem[^"]*"[^>]*>&gt; <!-- -->Checklist<\/div>/;
const CHECKLIST_HEADING_RE =
  /<h2 data-cms-fs="m" style="color:var\(--color-white\);--cms-e-fs-m:0\.875rem"[^>]*>What to have ready\.<\/h2>/;
const HIDDEN_DOTS_RE =
  /<div data-cms-hide-d="" data-cms-collapses="" class="flex justify-center gap-2 mt-8"/;

const docOf = (...blocks: Block[]): PageDoc => ({
  _schema: 1,
  seo: sampleSeo(),
  blocks,
});

const SAMPLE_POST = {
  slug: "blog/a",
  title: "A",
  excerpt: "",
  publishedAt: "2026-09-01",
  author: "Jane",
  readingTime: 1,
  category: "AI",
  tags: [],
};

function render(blocks: Block[], opts: { editing?: boolean } = {}): string {
  let tree: ReactNode = <PageRenderer doc={docOf(...blocks)} />;
  // One published post, so a postList has something to show (with none it renders nothing on the site).
  tree = (
    <CmsRenderContext.Provider value={{ posts: [SAMPLE_POST] }}>
      {tree}
    </CmsRenderContext.Provider>
  );
  if (opts.editing) {
    tree = (
      <EditModeContext.Provider value={{ editing: true }}>
        {tree}
      </EditModeContext.Provider>
    );
  }
  return renderToString(tree);
}

const block = (type: BlockType, overrides: BlockOverrides = {}): Block =>
  createBlock(type, { _key: `${type}1`, ...overrides });

describe("every registered block", () => {
  it.each([...BLOCK_TYPES])(
    "%s: defaults and default style validate, and createBlock round-trips",
    (type) => {
      const def = blockDef(type);
      expect(def.schema.safeParse(def.defaults()).success).toBe(true);
      const b = block(type);
      const parsed = parseBlock(b);
      expect(parsed.errors).toEqual([]);
      const result = validatePageDoc(docOf(b));
      expect(result.ok && result.doc.blocks[0]).toEqual(b);
    }
  );

  it.each([...BLOCK_TYPES])("%s: `onCard` names declared elements", (type) => {
    const def = blockDef(type);
    for (const name of def.onCard ?? []) {
      expect(Object.keys(def.elements)).toContain(name);
    }
  });

  it.each([...BLOCK_TYPES])(
    "%s: renders its defaults on the site and in the editor",
    (type) => {
      expect(render([block(type)])).toContain('class="cms-block"');
      expect(render([block(type)], { editing: true })).toContain(
        `data-cms-block="${type}"`
      );
    }
  );
});

describe("web registry", () => {
  it("pairs every cms-core def with a Component and its lucide Icon, in BLOCK_TYPES order", () => {
    expect(listBlocks().map((b) => b.type)).toEqual([...BLOCK_TYPES]);
    for (const type of BLOCK_TYPES) {
      const web = getBlock(type);
      expect(web).toMatchObject({ type, version: blockDef(type).version });
      expect(typeof web?.Component).toBe("function");
      expect(web?.Icon).toBe(BLOCK_ICONS[blockDef(type).icon]);
    }
  });

  it("has nothing for an unknown type", () => {
    expect(getBlock("carousel")).toBeUndefined();
    expect(getBlock("toString")).toBeUndefined();
  });

  it("hides only the post list, and only when it has no posts to show", () => {
    const hidden = listBlocks().filter((b) => b.hiddenWhen);
    expect(hidden.map((b) => b.type)).toEqual(["postList"]);
    const postList = getBlock("postList");
    const props = blockDef("postList").defaults();
    expect(postList?.hiddenWhen?.(props, {})).toBe(true);
    expect(postList?.hiddenWhen?.(props, { posts: [SAMPLE_POST] })).toBe(false);
  });
});

describe("backward compatibility", () => {
  it("keeps validating blocks written before the new variants and fields", () => {
    const old: Block[] = [
      {
        _key: "h",
        _type: "hero",
        _v: 1,
        props: { variant: "page", heading: "Hi" },
      },
      {
        _key: "g",
        _type: "featureGrid",
        _v: 1,
        props: {
          heading: "G",
          columns: 3,
          variant: "cards",
          items: [{ _key: "a", title: "A", body: richTextFromString("x") }],
        },
      },
      {
        _key: "f",
        _type: "faq",
        _v: 1,
        props: {
          heading: "F",
          items: [{ _key: "q", q: "Q?", a: richTextFromString("A.") }],
        },
      },
      {
        _key: "c",
        _type: "cta",
        _v: 1,
        props: { heading: "C", primary: { label: "Go", href: "/contact" } },
      },
    ];
    expect(validatePageDoc(docOf(...old)).ok).toBe(true);
  });

  it("requires a cta heading except in the compact variant", () => {
    const primary = { label: "Go", href: "/contact" };
    expect(
      parseBlock({ _key: "c", _type: "cta", _v: 1, props: { primary } })
        .errors[0]?.path
    ).toBe("props.heading");
    expect(
      parseBlock({
        _key: "c",
        _type: "cta",
        _v: 1,
        props: { variant: "compact", primary },
      }).errors
    ).toEqual([]);
  });

  it("reports an empty cta heading once", () => {
    const primary = { label: "Go", href: "/contact" };
    expect(
      parseBlock({
        _key: "c",
        _type: "cta",
        _v: 1,
        props: { heading: "", primary },
      }).errors.map((e) => e.path)
    ).toEqual(["props.heading"]);
  });
});

describe("accents", () => {
  it("wraps the accent words of a heading in a styleable span without changing the text", () => {
    const html = render([
      block("featureGrid", {
        props: {
          heading: "How We Transform Teams",
          headingAccent: "Transform Teams",
        },
      }),
    ]);
    expect(html).toContain(
      'How We <span class="text-primary">Transform Teams</span>'
    );
  });

  it("ignores an accent that isn't in the heading", () => {
    const html = render([
      block("cta", { props: { heading: "Ready?", headingAccent: "Nope" } }),
    ]);
    expect(html).toContain(">Ready?</h2>");
  });

  it("keeps accented text out of inline editing (the canvas edits single-text elements only)", () => {
    const accented = block("cta", {
      props: { heading: "Ready to Transform?", headingAccent: "Transform" },
    });
    const html = render([accented], { editing: true });
    expect(html).not.toContain('data-cms-field="heading"');
    expect(html).not.toContain('data-cms-field="headingAccent"');
    const plain = block("cta", { props: { heading: "Ready?" } });
    expect(render([plain], { editing: true })).toContain(
      'data-cms-field="heading"'
    );
  });

  it("lets an element colour override the accent's default", () => {
    const html = render([
      block("cta", {
        props: { heading: "Ready to Transform?", headingAccent: "Transform" },
        style: { elements: { headingAccent: { color: { token: "white" } } } },
      }),
    ]);
    expect(html).toMatch(WHITE_ACCENT_SPAN_RE);
  });
});

describe("hero home variant", () => {
  const hero = block("hero", {
    props: {
      variant: "home",
      eyebrow: "Tagline",
      heading: "Big heading",
      primary: { label: "One", href: "/a" },
      secondary: { label: "Two", href: "/b" },
      tertiary: { label: "Three", href: "/c" },
      logo: { mediaId: MEDIA_ID, alt: "Logo" },
    },
  });

  it("renders the bracketed tagline, three buttons and both logos (mobile and desktop)", () => {
    const html = render([hero]);
    expect(html).toMatch(BRACKETED_TAGLINE_RE);
    for (const label of ["One", "Two", "Three"]) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html.match(/alt="Logo"/g)?.length).toBe(2);
  });
});

describe("testimonial", () => {
  const items = [1, 2, 3].map((n) => ({
    _key: `t${n}`,
    quote: `Quote ${n}`,
    name: `Name ${n}`,
    role: "Role",
    company: n === 3 ? undefined : "Co",
  }));

  it("shows the first testimonial with accessible dots", () => {
    const html = render([
      block("testimonial", { props: { items, autoplay: 6 } }),
    ]);
    expect(html).toContain("&quot;<!-- -->Quote 1<!-- -->&quot;");
    expect(html).not.toContain("Quote 2");
    expect(html).toContain("Role at Co");
    expect(html).toContain('aria-label="Go to testimonial 3"');
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain('aria-label="Pause testimonials"');
  });

  it("has no pause button without autoplay", () => {
    expect(
      render([block("testimonial", { props: { items, autoplay: 0 } })])
    ).not.toContain("Pause testimonials");
  });

  it("has no dots for a single testimonial and no 'at' without a company", () => {
    const html = render([
      block("testimonial", { props: { items: [items[2]], autoplay: 0 } }),
    ]);
    expect(html).not.toContain("Go to testimonial");
    expect(html).toContain(">Role</div>");
  });

  it("keeps the dots usable in the editor", () => {
    const html = render(
      [block("testimonial", { props: { items, autoplay: 6 } })],
      { editing: true }
    );
    expect(html).toContain("data-cms-interactive");
  });
});

describe("steps", () => {
  it("renders bullet lists as ✓ rows, with the ✓ as text", () => {
    const html = render([block("steps")]);
    expect(html.match(/aria-hidden="true">✓<\/span>/g)?.length).toBe(6);
    expect(html).toContain(">01</span>");
    expect(html).not.toContain("list-disc");
  });
});

describe("pricing", () => {
  it("renders one plan as a single card with price, unit and note", () => {
    const html = render([
      block("pricing", {
        props: {
          plans: [
            {
              _key: "p",
              price: "$18,900 + GST",
              unit: "per 40-hour block",
              inclusions: [],
            },
          ],
          note: "Terms.",
        },
      }),
    ]);
    expect(html).toContain(
      '$18,900 + GST<!-- --> <span class="text-white/60 text-xl md:text-2xl">per 40-hour block</span>'
    );
    expect(html).toContain("Terms.");
  });

  it("renders several plans as cards with names, inclusions and buttons", () => {
    const html = render([
      block("pricing", {
        props: {
          plans: [
            {
              _key: "a",
              name: "Starter",
              price: "$1",
              inclusions: [{ _key: "i", text: "One thing" }],
              cta: { label: "Buy", href: "/contact" },
            },
            {
              _key: "b",
              name: "Pro",
              price: "$2",
              highlight: true,
              inclusions: [],
            },
          ],
        },
      }),
    ]);
    expect(html).toContain("Starter");
    expect(html).toContain("One thing");
    expect(html).toContain(">Buy</a>");
    // The highlight is an unlayered rule (cms.css), so a block border style can't hide it.
    expect(html.match(/data-cms-highlight=""/g)?.length).toBe(1);
  });
});

describe("logos", () => {
  it("renders text badges, the callout, the quote with line breaks and both button labels", () => {
    const html = render([
      block("logos", {
        props: {
          callout: { lead: "Lead line.", body: "Second line." },
          quote: "First line\nSecond line",
          button: {
            label: "Long label",
            shortLabel: "Short",
            href: "#contact",
          },
        },
      }),
    ]);
    expect(html).toContain("Proof point 1");
    expect(html).toContain("Lead line.");
    expect(html).toContain("First line<br/>Second line");
    expect(html).toContain('<span class="hidden sm:inline">Long label</span>');
    expect(html).toContain('<span class="sm:hidden">Short</span>');
  });
});

describe("faq", () => {
  it("shows every answer under its question", () => {
    const html = render([block("faq")]);
    expect(html).toContain("A common question?");
    expect(html).toContain("A short, direct answer.");
    expect(html).not.toContain("<details");
  });
});

describe("checklist", () => {
  it("renders a box per item and the note", () => {
    const html = render([block("checklist")]);
    expect(html).toContain("Something to prepare.");
    expect(html).toContain("Need help? Get in touch.");
    expect(html.match(/<li /g)?.length).toBe(1);
  });

  it("applies element colour and size to the eyebrow and heading", () => {
    const html = render([
      block("checklist", {
        style: {
          elements: {
            eyebrow: { color: { token: "danger" }, size: { desktop: "xl" } },
            heading: { color: { token: "white" }, size: { mobile: "sm" } },
          },
        },
      }),
    ]);
    expect(html).toMatch(CHECKLIST_EYEBROW_RE);
    expect(html).toMatch(CHECKLIST_HEADING_RE);
  });
});

describe("featureGrid services", () => {
  const items = [
    {
      _key: "a",
      title: "Card",
      body: {
        type: "doc" as const,
        content: [
          {
            type: "paragraph" as const,
            content: [
              { type: "text" as const, text: "See ", marks: [] },
              {
                type: "text" as const,
                text: "about",
                marks: [{ type: "link" as const, attrs: { href: "/about" } }],
              },
            ],
          },
        ],
      },
      link: { label: "Learn More →", href: "/services" },
    },
  ];

  it("links the card through its label (stretched), never nesting the body's links in another link", () => {
    const html = render([
      block("featureGrid", {
        props: { heading: "H", columns: 3, variant: "services", items },
      }),
    ]);
    expect(html).toContain('href="/about"');
    expect(html).toMatch(SERVICE_CARD_LINK_RE);
    const card = html.slice(html.indexOf("cms-card"));
    expect(card.indexOf('href="/about"')).toBeLessThan(
      card.indexOf('href="/services"')
    );
    expect(html).not.toMatch(CARD_AS_LINK_RE);
    expect(html).toMatch(LIFTED_CONTENT_RE);
  });
});

describe("hidden elements collapse their container", () => {
  const hiddenOnDesktop = { hide: { desktop: true, tablet: false } };

  it("hero: a logo hidden on a device hides its column there", () => {
    const html = render([
      block("hero", {
        props: {
          variant: "home",
          heading: "H",
          logo: { mediaId: MEDIA_ID, alt: "Logo" },
        },
        style: { elements: { logo: hiddenOnDesktop } },
      }),
    ]);
    expect(html).toMatch(HIDDEN_LOGO_COLUMN_RE);
  });

  it("logos: a hidden callout hides its box", () => {
    const html = render([
      block("logos", {
        props: { heading: "H", callout: { lead: "Lead" }, items: [] },
        style: { elements: { callout: hiddenOnDesktop } },
      }),
    ]);
    expect(html).toMatch(HIDDEN_CALLOUT_BOX_RE);
  });

  it("testimonial: a hidden card hides its dots and pause button", () => {
    const items = [1, 2].map((n) => ({
      _key: `t${n}`,
      quote: `Q${n}`,
      name: `N${n}`,
      role: "R",
    }));
    const html = render([
      block("testimonial", {
        props: { items, autoplay: 6 },
        style: { elements: { card: hiddenOnDesktop } },
      }),
    ]);
    expect(html).toMatch(HIDDEN_DOTS_RE);
  });
});
