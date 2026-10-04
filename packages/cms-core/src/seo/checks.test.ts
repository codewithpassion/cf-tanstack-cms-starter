// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; the regexes are not on a hot path.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim; each assertion follows a length or membership check.

import { describe, expect, it } from "bun:test";

import {
  type BlockOverrides,
  type BlockType,
  createBlock,
} from "../blocks/registry";
import { type RichTextDoc, richTextFromString } from "../richtext/schema";
import { defaultSeo } from "../site/seo-defaults";
import type { PublicSiteSeo } from "../site/types";
import { MEDIA_ID, sampleDoc, sampleSeo, TEST_CONFIG } from "../test-fixtures";
import type { Block, PageDoc, PageSeo } from "../types";
import {
  containsPhrase,
  effectiveSeo as effectiveSeoFor,
  pageOutline as pageOutlineFor,
  runSeoChecks as runSeoChecksFor,
  type SeoCheck,
  type SeoContext,
  seoScore,
  seoWarnings as seoWarningsFor,
} from "./checks";

const DEFAULT_SEO = defaultSeo(TEST_CONFIG);

// The tests build against one site config; these keep the call sites short.
const effectiveSeo = (d: PageDoc, site?: PublicSiteSeo) =>
  effectiveSeoFor(d, TEST_CONFIG, site);
const pageOutline = (d: PageDoc) => pageOutlineFor(d, TEST_CONFIG);
const runSeoChecks = (d: PageDoc, ctx: Partial<SeoContext> = {}) =>
  runSeoChecksFor(d, { config: TEST_CONFIG, ...ctx });
const seoWarnings = (d: PageDoc, ctx: Partial<SeoContext> = {}) =>
  seoWarningsFor(d, { config: TEST_CONFIG, ...ctx });

const block = (
  type: BlockType,
  key: string,
  overrides: BlockOverrides = {}
): Block => createBlock(type, { _key: key, ...overrides });

const doc = (blocks: Block[], seo: Partial<PageSeo> = {}): PageDoc => ({
  _schema: 1,
  seo: { ...sampleSeo(), ...seo },
  blocks,
});

const byId = (checks: SeoCheck[], id: string) => {
  const c = checks.find((x) => x.id === id);
  if (!c) {
    throw new Error(`no check ${id}`);
  }
  return c;
};

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

const rich = (...nodes: RichTextDoc["content"]): RichTextDoc => ({
  type: "doc",
  content: nodes,
});
const para = (text: string, href?: string) => ({
  type: "paragraph" as const,
  content: [
    {
      type: "text" as const,
      text,
      ...(href ? { marks: [{ type: "link" as const, attrs: { href } }] } : {}),
    },
  ],
});
const heading = (level: 2 | 3, text: string) => ({
  type: "heading" as const,
  attrs: { level },
  content: [{ type: "text" as const, text }],
});

/** A page that passes every check that can pass without context. */
function goodDoc(): PageDoc {
  return doc(
    [
      block("hero", "hero", {
        props: {
          variant: "page",
          heading: "AI strategy for Sydney teams",
          lead: "A practical AI strategy for growing businesses.",
        },
      }),
      block("richText", "body", {
        props: {
          body: rich(
            heading(2, "Why it matters"),
            para(words(320)),
            para("See our ", undefined),
            para("services", "/services"),
            para("process", "https://example.com/process"),
            heading(3, "Details")
          ),
        },
      }),
    ],
    {
      title: "AI strategy consulting",
      description:
        "A practical AI strategy for Australian businesses: what to automate first, what it costs and how to measure the payoff.",
      slug: "ai-strategy-consulting",
      focusKeyphrase: "AI strategy",
      social: { image: { mediaId: MEDIA_ID, alt: "AI strategy card" } },
    }
  );
}

const fullCtx: SeoContext = {
  config: TEST_CONFIG,
  pageId: "p1",
  others: [],
  media: { [MEDIA_ID]: { width: 1200, height: 630 } },
};

describe("effectiveSeo", () => {
  it("applies the site title template unless the title is exact, and falls back for social", () => {
    const eff = effectiveSeo(
      doc([], { title: "Pricing", description: "Desc" })
    );
    expect(eff.title).toBe("Pricing | Example Site");
    expect(eff.shareTitle).toBe("Pricing | Example Site");
    expect(eff.shareDescription).toBe("Desc");
    expect(eff.image).toEqual({
      src: "/og-image.jpg",
      alt: "",
      isDefault: true,
    });
    expect(eff.url).toBe("https://example.com/services/sample");
  });

  it("uses the published site's default share image when the page has none", () => {
    const site = {
      ...DEFAULT_SEO,
      defaultShareImage: {
        mediaId: MEDIA_ID,
        url: "/og-image.jpg",
        alt: "ACME card",
        width: 1200,
        height: 630,
      },
    };
    expect(effectiveSeo(doc([], { title: "Pricing" }), site).image).toEqual({
      src: `/media/${MEDIA_ID}`,
      alt: "ACME card",
      mediaId: MEDIA_ID,
      isDefault: true,
    });
    const byUrl = {
      ...DEFAULT_SEO,
      defaultShareImage: { url: "/cards/x.png", alt: "X" },
    };
    expect(effectiveSeo(doc([], { title: "Pricing" }), byUrl).image).toEqual({
      src: "/cards/x.png",
      alt: "X",
      isDefault: true,
    });
  });

  it("uses exact titles, social overrides and the share image", () => {
    const eff = effectiveSeo(
      doc([], {
        title: "Exact",
        titleExact: true,
        social: {
          title: "Social",
          description: "SD",
          image: { mediaId: MEDIA_ID, alt: "Alt" },
        },
      })
    );
    expect(eff.title).toBe("Exact");
    expect(eff.shareTitle).toBe("Social");
    expect(eff.shareDescription).toBe("SD");
    expect(eff.image).toEqual({
      src: `/media/${MEDIA_ID}`,
      alt: "Alt",
      mediaId: MEDIA_ID,
      isDefault: false,
    });
  });
});

describe("pageOutline", () => {
  it("reads headings, links, text and the first paragraph from the blocks", () => {
    const outline = pageOutline(sampleDoc());
    expect(outline.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Hello CMS"],
      [2, "Features"],
      [3, "One"],
      [3, "Two"],
      [2, "Questions"],
      [3, "What is it?"],
      [2, "Ready?"],
    ]);
    expect(outline.firstParagraph).toBe("Lead text.");
    expect(outline.links).toEqual([
      { href: "/contact", internal: true, blockKey: "hero1" },
      {
        href: "https://other.example.org/book",
        internal: false,
        blockKey: "cta1",
      },
    ]);
    expect(outline.texts).toContain("It is great.");
    expect(outline.texts).not.toContain("cards"); // enum values aren't text
    expect(outline.words).toBeGreaterThan(10);
  });

  it("skips blocks hidden on every device", () => {
    const hidden = block("cta", "cta", {
      style: { hide: { desktop: true, tablet: true, mobile: true } },
    });
    expect(pageOutline(doc([hidden])).headings).toEqual([]);
    const mobileOnly = block("cta", "cta", {
      style: { hide: { desktop: true, mobile: false } },
    });
    expect(pageOutline(doc([mobileOnly])).headings).toHaveLength(1);
  });

  it("collects image alt text and rich-text links", () => {
    const outline = pageOutline(
      doc([
        block("image", "img1", { props: { mediaId: MEDIA_ID, alt: "" } }),
        block("image", "img2", {
          props: { mediaId: MEDIA_ID, alt: "A chart" },
        }),
        block("image", "img3", { props: { alt: "" } }), // nothing picked: renders nothing
        block("richText", "rt", {
          props: { body: rich(para("x", "/about"), para("y", "mailto:a@b.c")) },
        }),
      ])
    );
    expect(outline.images.map((i) => [i.blockKey, i.alt])).toEqual([
      ["img1", ""],
      ["img2", "A chart"],
    ]);
    expect(outline.links.map((l) => [l.href, l.internal])).toEqual([
      ["/about", true],
      ["mailto:a@b.c", false],
    ]);
  });

  it("skips blocks that don't validate (the renderer skips them too)", () => {
    const bad = { ...block("hero", "h"), props: { variant: "page" } }; // no heading
    const outline = pageOutline(doc([bad, block("cta", "c")]));
    expect(outline.headings.map((h) => h.blockKey)).toEqual(["c"]);
  });

  it("leaves out elements hidden on every device: their text, links and images", () => {
    const all = { desktop: true, tablet: true, mobile: true };
    const hero = block("hero", "h", {
      props: {
        variant: "page",
        eyebrow: null,
        heading: "Title",
        lead: "Lead words here",
        primary: { label: "Go", href: "/contact" },
      },
      style: { elements: { lead: { hide: all }, buttons: { hide: all } } },
    });
    const body = block("richText", "r", {
      props: { body: rich(para("Hidden words", "/about")) },
      style: { elements: { body: { hide: all } } },
    });
    const img = block("image", "i", {
      props: { mediaId: MEDIA_ID, alt: "" },
      style: { elements: { image: { hide: all } } },
    });
    const outline = pageOutline(doc([hero, body, img]));
    expect(outline.texts).toEqual(["Title"]);
    expect(outline.links).toEqual([]);
    expect(outline.images).toEqual([]);
    expect(outline.firstParagraph).toBe("");
    // Hidden on some devices only: still on the page.
    const some = block("hero", "h", {
      props: { variant: "page", eyebrow: null, heading: "T", lead: "L" },
      style: { elements: { lead: { hide: { mobile: true } } } },
    });
    expect(pageOutline(doc([some])).firstParagraph).toBe("L");
  });
});

describe("containsPhrase", () => {
  it("matches whole words, ignoring case, punctuation and accents", () => {
    expect(containsPhrase("Café-grade AI Strategy!", "ai strategy")).toBe(true);
    expect(containsPhrase("cafe grade", "Café")).toBe(true);
    expect(containsPhrase("paint strategy", "ai strategy")).toBe(false);
    expect(containsPhrase("anything", "  ")).toBe(false);
  });
});

describe("runSeoChecks", () => {
  it("passes a well-built page with context", () => {
    const checks = runSeoChecks(goodDoc(), fullCtx);
    const notPassing = checks.filter(
      (c) => c.status !== "pass" && c.status !== "na"
    );
    expect(notPassing).toEqual([]);
    expect(seoScore(checks)).toBe(100);
    expect(byId(checks, "contrast").status).toBe("na");
  });

  it("returns the same results for the same input", () => {
    expect(runSeoChecks(goodDoc(), fullCtx)).toEqual(
      runSeoChecks(goodDoc(), fullCtx)
    );
  });

  it("marks context-dependent checks n/a without context", () => {
    const checks = runSeoChecks(goodDoc());
    expect(byId(checks, "title-unique").status).toBe("na");
    expect(byId(checks, "description-unique").status).toBe("na");
    expect(byId(checks, "share-image").status).toBe("na");
  });

  describe("title", () => {
    it("warns when the full title is wider than ~580px", () => {
      const c = byId(
        runSeoChecks(
          doc([], {
            title:
              "A very long page title about AI transformation services for teams",
          })
        ),
        "title-length"
      );
      expect(c.status).toBe("warn");
      expect(c.message).toMatch(/px wide/);
    });

    it("fails a duplicate title on both pages, ignoring case", () => {
      const a = doc([], { title: "Same title", slug: "a" });
      const b = doc([], { title: "same TITLE", slug: "b" });
      const other = (id: string, d: PageDoc) => ({
        id,
        slug: d.seo.slug,
        title: effectiveSeo(d).title,
        description: d.seo.description,
      });
      const onA = byId(
        runSeoChecks(a, {
          pageId: "a",
          others: [other("a", a), other("b", b)],
        }),
        "title-unique"
      );
      const onB = byId(
        runSeoChecks(b, {
          pageId: "b",
          others: [other("a", a), other("b", b)],
        }),
        "title-unique"
      );
      expect(onA).toMatchObject({
        status: "fail",
        message: "Same title as /b.",
      });
      expect(onB).toMatchObject({
        status: "fail",
        message: "Same title as /a.",
      });
    });

    it("compares titles ignoring whitespace and punctuation, and against static pages' titles", () => {
      const others = [
        {
          id: "x",
          slug: "x",
          title: "Pricing – Plans | Example Site",
          description: "",
        },
      ];
      const d = doc([], { title: "Pricing  plans!" });
      expect(byId(runSeoChecks(d, { others }), "title-unique")).toMatchObject({
        status: "fail",
        message: "Same title as /x.",
      });
      // This site's static pages (the sign-in screens) show the root title.
      const asLogin = doc([], {
        title: "Example Site",
        titleExact: true,
      });
      expect(
        byId(runSeoChecks(asLogin, { others: [] }), "title-unique")
      ).toMatchObject({
        status: "fail",
        message: "Same title as /login, /dev-login.",
      });
    });

    it("warns when the title already has the site name the template adds", () => {
      const twice = byId(
        runSeoChecks(doc([], { title: "Pricing | Example Site" })),
        "title-length"
      );
      expect(twice).toMatchObject({
        status: "warn",
        message: expect.stringMatching(/shows twice/),
      });
      expect(
        byId(
          runSeoChecks(
            doc([], {
              title: "Pricing | Example Site",
              titleExact: true,
            })
          ),
          "title-length"
        ).status
      ).toBe("pass");
      expect(
        byId(runSeoChecks(doc([], { title: "Example hiring" })), "title-length")
          .status
      ).toBe("pass");
    });

    it("uses the published site's title template: length on the full title, double suffix against that template", () => {
      const site = {
        ...DEFAULT_SEO,
        titleTemplate: "%s — ACME Consulting Group Australia",
      };
      // Fits with the default template; too wide with this longer one.
      const title = "AI transformation services for SMEs";
      expect(
        byId(runSeoChecks(doc([], { title })), "title-length").status
      ).toBe("pass");
      const long = byId(
        runSeoChecks(doc([], { title }), { site }),
        "title-length"
      );
      expect(long).toMatchObject({
        status: "warn",
        message: expect.stringMatching(/px wide/),
      });
      // The default template's suffix is no longer "the site name"; this template's is.
      expect(
        byId(
          runSeoChecks(doc([], { title: "Pricing | Example Site" }), {
            site,
          }),
          "title-length"
        ).message
      ).not.toMatch(/shows twice/);
      const twice = byId(
        runSeoChecks(
          doc([], { title: "Pricing — ACME Consulting Group Australia" }),
          { site }
        ),
        "title-length"
      );
      expect(twice).toMatchObject({
        status: "warn",
        message: expect.stringMatching(/shows twice/),
      });
      // A template that prefixes.
      const prefix = { ...DEFAULT_SEO, titleTemplate: "ACME: %s" };
      expect(
        byId(
          runSeoChecks(doc([], { title: "ACME: Pricing" }), { site: prefix }),
          "title-length"
        ).message
      ).toMatch(/shows twice/);
      expect(effectiveSeo(doc([], { title: "Pricing" }), prefix).title).toBe(
        "ACME: Pricing"
      );
    });

    it("doesn't treat an exact title as equal to the templated one", () => {
      const a = doc([], { title: "Pricing", titleExact: true });
      const others = [
        {
          id: "x",
          slug: "x",
          title: "Pricing | Example Site",
          description: "",
        },
      ];
      expect(byId(runSeoChecks(a, { others }), "title-unique").status).toBe(
        "pass"
      );
    });
  });

  describe("description", () => {
    it.each([
      ["", "warn", /No description/],
      ["Too short.", "warn", /Only 10 characters/],
      ["word ".repeat(60).trim(), "warn", /px wide/],
    ])("%j → %s", (description, status, message) => {
      const c = byId(
        runSeoChecks(doc([], { description })),
        "description-length"
      );
      expect<string>(c.status).toBe(status);
      expect(c.message).toMatch(message);
    });

    it("warns on a duplicate description", () => {
      const d = goodDoc();
      const others = [
        {
          id: "x",
          slug: "other",
          title: "Other",
          description: d.seo.description,
        },
      ];
      expect(
        byId(runSeoChecks(d, { others }), "description-unique")
      ).toMatchObject({
        status: "warn",
        message: "Same description as /other.",
      });
    });
  });

  describe("headings", () => {
    it("warns when the H1 is hidden on mobile (its block or its heading)", () => {
      const element = doc([
        block("hero", "h", {
          style: { elements: { heading: { hide: { mobile: true } } } },
        }),
      ]);
      expect(byId(runSeoChecks(element), "h1")).toMatchObject({
        status: "warn",
        message: expect.stringMatching(/hidden on mobile/),
      });
      const whole = doc([
        block("hero", "h", { style: { hide: { mobile: true } } }),
      ]);
      expect(byId(runSeoChecks(whole), "h1").status).toBe("warn");
      const desktop = doc([
        block("hero", "h", {
          style: { hide: { desktop: true, mobile: false } },
        }),
      ]);
      expect(byId(runSeoChecks(desktop), "h1").status).toBe("pass");
    });

    it("fails when the only H1 is hidden on every device", () => {
      const hidden = doc([
        block("hero", "h", {
          style: {
            elements: {
              heading: { hide: { desktop: true, tablet: true, mobile: true } },
            },
          },
        }),
      ]);
      expect(byId(runSeoChecks(hidden), "h1").status).toBe("fail");
    });

    it("fails with no H1 or two H1s", () => {
      expect(byId(runSeoChecks(doc([block("cta", "c")])), "h1").status).toBe(
        "fail"
      );
      const two = doc([block("hero", "h1"), block("hero", "h2")]);
      expect(byId(runSeoChecks(two), "h1")).toMatchObject({
        status: "fail",
        message: "2 H1s: keep one hero per page.",
      });
      expect(byId(runSeoChecks(two), "heading-order").status).toBe("warn");
    });

    it("warns when a level is skipped or the H1 isn't first", () => {
      const skip = doc([
        block("hero", "h"),
        block("richText", "r", { props: { body: rich(heading(3, "Deep")) } }),
      ]);
      expect(byId(runSeoChecks(skip), "heading-order").message).toBe(
        "H3 “Deep” follows an H1; don't skip a level."
      );
      const late = doc([block("cta", "c"), block("hero", "h")]);
      expect(byId(runSeoChecks(late), "heading-order").message).toMatch(
        /comes before the H1/
      );
    });
  });

  describe("keyphrase", () => {
    it("asks for a keyphrase when there is none", () => {
      const checks = runSeoChecks(doc([]));
      expect(byId(checks, "keyphrase").status).toBe("warn");
      expect(checks.some((c) => c.id === "keyphrase-title")).toBe(false);
    });

    it("checks title, H1, first paragraph and URL", () => {
      const d = goodDoc();
      d.seo.focusKeyphrase = "Sydney teams";
      const checks = runSeoChecks(d);
      expect(byId(checks, "keyphrase-title").status).toBe("warn");
      expect(byId(checks, "keyphrase-h1").status).toBe("pass");
      expect(byId(checks, "keyphrase-intro").status).toBe("warn");
      expect(byId(checks, "keyphrase-slug").status).toBe("warn");
    });

    it("accepts singular and plural forms, and looks for it in the page's own title", () => {
      const d = goodDoc();
      d.seo.focusKeyphrase = "AI strategies";
      const checks = runSeoChecks(d);
      expect(byId(checks, "keyphrase-title").status).toBe("pass");
      expect(byId(checks, "keyphrase-h1").status).toBe("pass");
      expect(containsPhrase("Training boxes and classes", "training box")).toBe(
        true
      );
      expect(containsPhrase("business class", "business classes")).toBe(true);
      // The site name the template adds isn't the page's title.
      d.seo.focusKeyphrase = "Example";
      expect(byId(runSeoChecks(d), "keyphrase-title").status).toBe("warn");
    });

    it("is n/a in the URL of the home page", () => {
      const d = goodDoc();
      d.seo.slug = "";
      expect(byId(runSeoChecks(d), "keyphrase-slug").status).toBe("na");
    });
  });

  it("fails images without alt text", () => {
    const d = doc([
      block("hero", "h"),
      block("image", "i", { props: { mediaId: MEDIA_ID, alt: " " } }),
    ]);
    expect(byId(runSeoChecks(d), "image-alt")).toMatchObject({
      status: "fail",
      message: "1 of 1 images have no alt text (Image).",
    });
    expect(byId(runSeoChecks(doc([])), "image-alt").status).toBe("na");
  });

  it("counts internal links out of the page, not to itself or other sites", () => {
    const d = doc([
      block("richText", "r", {
        props: {
          body: rich(
            para("self", "/services/sample"),
            para("ext", "https://other.example.org"),
            para("one", "/about"),
            para("anchor", "#top")
          ),
        },
      }),
    ]);
    expect(byId(runSeoChecks(d), "internal-links")).toMatchObject({
      status: "warn",
      message:
        "Links to 1 other page on the site; link to at least 2 related pages.",
    });
  });

  it("counts each linked page once", () => {
    const d = doc([
      block("richText", "r", {
        props: {
          body: rich(
            para("a", "/about"),
            para("b", "/about#team"),
            para("c", "https://example.com/about/")
          ),
        },
      }),
    ]);
    expect(byId(runSeoChecks(d), "internal-links").message).toMatch(
      /^Links to 1 other page/
    );
  });

  it("warns under 300 words", () => {
    const c = byId(
      runSeoChecks(
        doc([
          block("richText", "r", {
            props: { body: richTextFromString(words(299)) },
          }),
        ])
      ),
      "word-count"
    );
    expect(c).toMatchObject({
      status: "warn",
      message: "299 words; pages under 300 rarely rank.",
    });
    const ok = byId(
      runSeoChecks(
        doc([
          block("richText", "r", {
            props: { body: richTextFromString(words(300)) },
          }),
        ])
      ),
      "word-count"
    );
    expect(ok.status).toBe("pass");
  });

  it.each([
    ["", "pass"],
    ["services/ai", "pass"],
    ["Bad_Slug", "fail"],
    [`a-${"x".repeat(80)}`, "warn"],
    ["a/b/c/d", "warn"],
  ])("slug %j → %s", (slug, status) => {
    expect<string>(byId(runSeoChecks(doc([], { slug })), "slug").status).toBe(
      status
    );
  });

  it("fails the slugs publishing refuses: reserved, blog/ for pages, and / for any page but the home page", () => {
    const slug = (s: string, ctx: Partial<SeoContext> = {}) =>
      byId(runSeoChecks(doc([], { slug: s }), ctx), "slug");
    expect(slug("login")).toMatchObject({
      status: "fail",
      message: expect.stringMatching(/built into the site/),
    });
    expect(slug("admin/perth").status).toBe("fail");
    expect(slug("about-us").status).toBe("pass");
    expect(slug("blog/hello").status).toBe("fail");
    expect(slug("blog/hello", { kind: "post" }).status).toBe("pass");
    expect(slug("news/hello", { kind: "post" }).status).toBe("fail");
    expect(slug("", { isHome: true }).status).toBe("pass");
    expect(slug("", { isHome: false })).toMatchObject({
      status: "fail",
      message: expect.stringMatching(/home page/),
    });
  });

  describe("share image", () => {
    it("warns without one, without alt, or at the wrong size", () => {
      expect(
        byId(runSeoChecks(doc([]), fullCtx), "share-image").message
      ).toMatch(/site default/);
      const noAlt = doc([], {
        social: { image: { mediaId: MEDIA_ID, alt: "" } },
      });
      expect(byId(runSeoChecks(noAlt, fullCtx), "share-image").message).toMatch(
        /no alt/
      );
      const wrong = doc([], {
        social: { image: { mediaId: MEDIA_ID, alt: "x" } },
      });
      const c = byId(
        runSeoChecks(wrong, {
          media: { [MEDIA_ID]: { width: 800, height: 800 } },
        }),
        "share-image"
      );
      expect(c).toMatchObject({ status: "warn" });
      expect(c.message).toMatch(/^800×800/);
    });

    it("fails when the image isn't in the media library", () => {
      const d = doc([], { social: { image: { mediaId: MEDIA_ID, alt: "x" } } });
      expect(byId(runSeoChecks(d, { media: {} }), "share-image")).toMatchObject(
        {
          status: "fail",
          message: expect.stringMatching(/isn't in the media library/),
        }
      );
    });

    it("passes at 1200×630", () => {
      const d = doc([], { social: { image: { mediaId: MEDIA_ID, alt: "x" } } });
      expect(byId(runSeoChecks(d, fullCtx), "share-image").status).toBe("pass");
    });

    it("a post without its own uses its featured image, and its excerpt as the description (as the head does)", () => {
      const d: PageDoc = {
        ...doc([], { description: "", slug: "blog/x" }),
        post: {
          excerpt:
            "An excerpt long enough to stand in for the meta description of this post, as the head uses it.",
          author: "A",
          publishedAt: "2026-10-01",
          category: "C",
          tags: [],
          readingTime: 1,
          featuredImage: { mediaId: MEDIA_ID, alt: "Cover" },
        },
      };
      const checks = runSeoChecks(d, { ...fullCtx, kind: "post" });
      expect(byId(checks, "share-image").status).toBe("pass");
      expect(byId(checks, "description-length").message).not.toMatch(
        /No description/
      );
    });
  });

  it.each([
    [true, true, "pass"],
    [true, false, "warn"],
    [false, true, "info"],
    [false, false, "info"],
  ])("index %s, sitemap %s → %s", (index, include, status) => {
    const c = byId(
      runSeoChecks(
        doc([], { robots: { index, follow: true }, sitemap: { include } })
      ),
      "indexing"
    );
    expect<string>(c.status).toBe(status);
    if (!index) {
      expect(c.message).toMatch(/left out of the sitemap/);
    }
  });

  describe("structured data", () => {
    it("passes typed nodes and lists their types", () => {
      const c = byId(runSeoChecks(sampleDoc()), "json-ld");
      expect(c.status).toBe("pass");
      expect(c.message).toMatch(/BreadcrumbList, WebPage, FAQPage/);
    });

    it("fails a node without @type", () => {
      const d = doc([], {
        schema: { pageType: "WebPage", extra: [{ "@type": "", name: "x" }] },
      });
      expect(byId(runSeoChecks(d), "json-ld")).toMatchObject({
        status: "fail",
        message: "1 node has no @type.",
      });
    });

    it("warns when an FAQ block emits no FAQPage, or there are two", () => {
      const d = sampleDoc();
      d.blocks[2]!.style = {
        elements: {
          items: { hide: { desktop: true, tablet: true, mobile: true } },
        },
      };
      expect(byId(runSeoChecks(d), "json-ld").message).toMatch(/no FAQPage/);
      const two = sampleDoc();
      two.seo.schema.extra = [{ "@type": "FAQPage", mainEntity: [] }];
      expect(byId(runSeoChecks(two), "json-ld").message).toMatch(
        /2 FAQPage nodes/
      );
    });
  });

  describe("colour contrast", () => {
    it("rates solid colour pairs and warns below AA", () => {
      const bad = block("cta", "c", {
        style: {
          background: { color: { hex: "#ffffff" }, gradient: "none" },
          colors: { text: { hex: "#eeeeee" } },
        },
      });
      const c = byId(runSeoChecks(doc([bad])), "contrast");
      expect(c.status).toBe("warn");
      expect(c.message).toMatch(/^Below WCAG AA: Call to action text 1\.\d:1/);
      const good = block("cta", "c", {
        style: {
          background: { color: { hex: "#000000" }, gradient: "none" },
          colors: { text: { hex: "#ffffff" } },
        },
      });
      expect(byId(runSeoChecks(doc([good])), "contrast")).toMatchObject({
        status: "pass",
        message: "1 rated colour pair meet WCAG AA.",
      });
    });
  });
});

describe("seoScore and seoWarnings", () => {
  it("scores pass 1, warn ½, fail 0 and ignores n/a", () => {
    const c = (status: SeoCheck["status"]): SeoCheck => ({
      id: status,
      label: status,
      status,
      message: "",
    });
    expect(seoScore([c("pass"), c("warn"), c("fail"), c("na")])).toBe(50);
    expect(seoScore([c("na")])).toBe(100);
  });

  it("lists warnings and failures with their labels", () => {
    const warnings = seoWarnings(doc([], { title: "x", description: "" }), {});
    expect(warnings).toContainEqual({
      level: "fail",
      message:
        "One H1: No H1: add a hero block (its heading is the page's H1).",
    });
    expect(warnings).toContainEqual({
      level: "warn",
      message:
        "Meta description: No description: Google will pick text from the page.",
    });
    expect(
      warnings.every((w) => w.level === "warn" || w.level === "fail")
    ).toBe(true);
  });
});

describe("posts", () => {
  it("count the post title, which the post layout renders, as the H1", () => {
    const post = {
      excerpt: "",
      author: "A",
      publishedAt: "2026-10-01",
      category: "C",
      tags: [],
      readingTime: 1,
    };
    const d: PageDoc = {
      ...doc(
        [
          block("richText", "r", {
            props: { body: rich(heading(2, "Section"), para(words(20))) },
          }),
        ],
        { title: "My post" }
      ),
      post,
    };
    expect(pageOutline(d).headings.map((h) => [h.level, h.text])).toEqual([
      [1, "My post"],
      [2, "Section"],
    ]);
    expect(byId(runSeoChecks(d), "h1").status).toBe("pass");
    expect(byId(runSeoChecks(doc([block("richText", "r")])), "h1").status).toBe(
      "fail"
    );
  });
});
