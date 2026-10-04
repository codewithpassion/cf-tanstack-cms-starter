// biome-ignore-all lint/suspicious/noReturnAssign: one-line doc/site patch callbacks, ported verbatim from the source test.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: the default patch is an intentional no-op, as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the test proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/useTemplate: ported verbatim from the source test (kept diffable).
import { describe, expect, it } from "bun:test";
import { buildJsonLd as buildJsonLdFor } from "../render/page-json-ld";
import { defaultSeo } from "../site/seo-defaults";
import type { PublicSiteSeo } from "../site/types";
import { MEDIA_ID, sampleDoc, TEST_CONFIG } from "../test-fixtures";
import type { PageDoc } from "../types";
import { buildHead as buildHeadFor } from "./build-head";

const BASE = TEST_CONFIG.origin;
const DEFAULT_SEO = defaultSeo(TEST_CONFIG);

const buildHead = (d: PageDoc, path: string, site?: PublicSiteSeo) =>
  buildHeadFor(d, path, TEST_CONFIG, site);
const buildJsonLd = (d: PageDoc, path: string, parents: string[] = []) =>
  buildJsonLdFor(d, path, TEST_CONFIG, parents);

function doc(patch: (d: PageDoc) => void = () => {}): PageDoc {
  const d = sampleDoc();
  patch(d);
  return d;
}

function meta(
  head: ReturnType<typeof buildHead>,
  key: string
): string | undefined {
  for (const tag of head.meta) {
    if (key === "title" && "title" in tag) {
      return tag.title;
    }
    if ("name" in tag && tag.name === key) {
      return tag.content;
    }
    if ("property" in tag && tag.property === key) {
      return tag.content;
    }
  }
}

describe("buildHead", () => {
  it("matches the existing routes' tags for a default page", () => {
    const head = buildHead(doc(), "/services/sample");
    expect(head).toEqual({
      meta: [
        { title: "Sample page | Example Site" },
        { name: "description", content: "A sample page." },
        { name: "robots", content: "index, follow" },
        { name: "author", content: "Example Site" },
        { property: "og:type", content: "website" },
        {
          property: "og:title",
          content: "Sample page | Example Site",
        },
        { property: "og:description", content: "A sample page." },
        { property: "og:url", content: `${BASE}/services/sample` },
        { property: "og:image", content: `${BASE}/og-image.jpg` },
        { name: "twitter:card", content: "summary_large_image" },
        {
          name: "twitter:title",
          content: "Sample page | Example Site",
        },
        { name: "twitter:description", content: "A sample page." },
        { name: "twitter:image", content: `${BASE}/og-image.jpg` },
      ],
      links: [{ rel: "canonical", href: `${BASE}/services/sample` }],
    });
  });

  it("uses the exact title when titleExact is set", () => {
    const head = buildHead(
      doc((d) => (d.seo.titleExact = true)),
      "/x"
    );
    expect(meta(head, "title")).toBe("Sample page");
  });

  it.each([
    [true, true, "index, follow"],
    [false, true, "noindex, follow"],
    [true, false, "index, nofollow"],
    [false, false, "noindex, nofollow"],
  ])("robots index=%s follow=%s → %s", (index, follow, expected) => {
    const head = buildHead(
      doc((d) => (d.seo.robots = { index, follow })),
      "/x"
    );
    expect(meta(head, "robots")).toBe(expected);
  });

  it("canonical: home has no trailing slash; an explicit canonical wins", () => {
    expect(buildHead(doc(), "/").links).toEqual([
      { rel: "canonical", href: BASE },
    ]);
    const other = buildHead(
      doc((d) => (d.seo.canonical = "https://example.com/original")),
      "/x"
    );
    expect(other.links).toEqual([
      { rel: "canonical", href: "https://example.com/original" },
    ]);
    expect(meta(other, "og:url")).toBe("https://example.com/original");
  });

  it("social overrides and share image with its stored size and alt", () => {
    const head = buildHead(
      doc((d) => {
        d.seo.social = {
          title: "Share me",
          description: "Shared.",
          image: { mediaId: MEDIA_ID, alt: "A card", width: 1200, height: 630 },
        };
      }),
      "/x"
    );
    const image = `${BASE}/media/${MEDIA_ID}`;
    expect(meta(head, "og:title")).toBe("Share me");
    expect(meta(head, "twitter:title")).toBe("Share me");
    expect(meta(head, "og:description")).toBe("Shared.");
    expect(meta(head, "twitter:description")).toBe("Shared.");
    expect(meta(head, "og:image")).toBe(image);
    expect(meta(head, "twitter:image")).toBe(image);
    expect(meta(head, "og:image:width")).toBe("1200");
    expect(meta(head, "og:image:height")).toBe("630");
    expect(meta(head, "og:image:alt")).toBe("A card");
    expect(meta(head, "twitter:image:alt")).toBe("A card");
    // The page's own title and description are unaffected.
    expect(meta(head, "title")).toBe("Sample page | Example Site");
    expect(meta(head, "description")).toBe("A sample page.");
  });

  it("takes the share image's size from the doc, and omits it when the doc has none (never guessed)", () => {
    const sized = buildHead(
      doc(
        (d) =>
          (d.seo.social.image = {
            mediaId: MEDIA_ID,
            alt: "Square",
            width: 800,
            height: 800,
          })
      ),
      "/x"
    );
    expect(meta(sized, "og:image:width")).toBe("800");
    expect(meta(sized, "og:image:height")).toBe("800");
    const unsized = buildHead(
      doc(
        (d) => (d.seo.social.image = { mediaId: MEDIA_ID, alt: "Older pick" })
      ),
      "/x"
    );
    expect(meta(unsized, "og:image")).toBe(`${BASE}/media/${MEDIA_ID}`);
    expect(meta(unsized, "og:image:width")).toBeUndefined();
    expect(meta(unsized, "og:image:height")).toBeUndefined();
    expect(meta(unsized, "og:image:alt")).toBe("Older pick");
  });

  it("articles get og:type article and the post author", () => {
    const head = buildHead(
      doc((d) => {
        d.seo.schema.pageType = "Article";
        d.post = {
          excerpt: "",
          author: "Jane Doe",
          publishedAt: "2026-10-01",
          category: "AI",
          tags: [],
          readingTime: 3,
        };
      }),
      "/blog/x"
    );
    expect(meta(head, "og:type")).toBe("article");
    expect(meta(head, "author")).toBe("Jane Doe");
  });

  const postDoc = (patch: (d: PageDoc) => void = () => {}) =>
    doc((d) => {
      d.seo.description = "";
      d.seo.schema.pageType = "Article";
      d.post = {
        excerpt: "The post's excerpt.",
        author: "Jane Doe",
        publishedAt: "2026-10-01",
        category: "AI",
        tags: [],
        readingTime: 3,
        featuredImage: { mediaId: MEDIA_ID, alt: "Cover" },
      };
      patch(d);
    });

  it("a post without a meta description or share image uses its excerpt and featured image (head and Article)", () => {
    const d = postDoc();
    const head = buildHead(d, "/blog/x");
    for (const key of [
      "description",
      "og:description",
      "twitter:description",
    ]) {
      expect(meta(head, key)).toBe("The post's excerpt.");
    }
    for (const key of ["og:image", "twitter:image"]) {
      expect(meta(head, key)).toBe(`${BASE}/media/${MEDIA_ID}`);
    }
    expect(meta(head, "og:image:alt")).toBe("Cover");
    // No stored size for a featured image: no size tags rather than a guess.
    expect(meta(head, "og:image:width")).toBeUndefined();
    const article = buildJsonLd(d, "/blog/x").find(
      (n) => n["@type"] === "Article"
    );
    expect(article?.description).toBe("The post's excerpt.");
  });

  it("a post's own meta description and share image win over its excerpt and featured image", () => {
    const d = postDoc((p) => {
      p.seo.description = "SEO description.";
      p.seo.social.image = { mediaId: "b".repeat(16), alt: "Share" };
    });
    const head = buildHead(d, "/blog/x");
    expect(meta(head, "description")).toBe("SEO description.");
    expect(meta(head, "og:image")).toBe(`${BASE}/media/${"b".repeat(16)}`);
    expect(
      buildJsonLd(d, "/blog/x").find((n) => n["@type"] === "Article")
        ?.description
    ).toBe("SEO description.");
  });
});

describe("buildJsonLd", () => {
  it("emits breadcrumbs, the page node, block JSON-LD and schema.extra, each with @context", () => {
    const nodes = buildJsonLd(
      doc((d) => {
        d.seo.schema.breadcrumbLabel = "Sample";
        d.seo.schema.extra = [{ "@type": "Service", name: "Sample service" }];
      }),
      "/services/sample",
      ["services"]
    );
    expect(nodes.map((n) => n["@type"])).toEqual([
      "BreadcrumbList",
      "WebPage",
      "FAQPage",
      "Service",
    ]);
    expect(nodes.every((n) => n["@context"] === "https://schema.org")).toBe(
      true
    );
    expect(nodes[0]).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: BASE },
        {
          "@type": "ListItem",
          position: 2,
          name: "Services",
          item: `${BASE}/services`,
        },
        {
          "@type": "ListItem",
          position: 3,
          name: "Sample",
          item: `${BASE}/services/sample`,
        },
      ],
    });
    expect(nodes[1]).toEqual({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Sample page",
      description: "A sample page.",
      url: `${BASE}/services/sample`,
    });
  });

  it("merges the first schema.extra node of the page's type into the page node (derived keys win, extra adds)", () => {
    const nodes = buildJsonLd(
      doc((d) => {
        d.seo.schema.pageType = "Service";
        d.seo.schema.extra = [
          { "@type": "Organization", name: "Org" },
          {
            "@type": "Service",
            "@id": `${BASE}/#other`,
            name: "Sample service",
            description: "Stale description",
            url: `${BASE}/elsewhere`,
            breadcrumb: { "@id": "x" },
            offers: { "@type": "Offer", price: 1 },
            areaServed: "AU",
          },
          { "@type": "Service", name: "Second service" },
        ];
      }),
      "/services/sample"
    );
    expect(nodes.map((n) => n["@type"])).toEqual([
      "BreadcrumbList",
      "Service",
      "FAQPage",
      "Organization",
      "Service",
    ]);
    expect(nodes[1]).toEqual({
      "@context": "https://schema.org",
      "@type": "Service",
      name: "Sample page",
      description: "A sample page.",
      url: `${BASE}/services/sample`,
      offers: { "@type": "Offer", price: 1 },
      areaServed: "AU",
    });
  });

  it("lets the page node's extra override the derived keys it lists in `_override`", () => {
    const [, page] = buildJsonLd(
      doc((d) => {
        d.seo.schema.pageType = "Service";
        d.seo.schema.extra = [
          {
            "@type": "Service",
            _override: ["name", "description"],
            name: "Brand name",
            description: "Brand blurb",
            url: `${BASE}/x`,
          },
        ];
      }),
      "/services/sample"
    );
    expect(page).toEqual({
      "@context": "https://schema.org",
      "@type": "Service",
      name: "Brand name",
      description: "Brand blurb",
      url: `${BASE}/services/sample`,
    });
  });

  it("forces the schema.org @context on every node and never emits `_override`", () => {
    const nodes = buildJsonLd(
      doc((d) => {
        d.seo.schema.extra = [
          {
            "@context": "http://evil.example",
            "@type": "Organization",
            name: "Org",
            _override: ["name"],
          },
          { "@context": { "@vocab": "http://example.com/" }, "@type": "Thing" },
        ];
      }),
      "/services/sample"
    );
    expect(nodes.map((n) => n["@context"])).toEqual(
      nodes.map(() => "https://schema.org")
    );
    expect(nodes.some((n) => "_override" in n)).toBe(false);
  });

  it("labels the last crumb with the title by default and title-cases parent segments", () => {
    const [crumbs] = buildJsonLd(doc(), "/ai-services/sample", ["ai-services"]);
    const items = crumbs!.itemListElement as { name: string }[];
    expect(items.map((i) => i.name)).toEqual([
      "Home",
      "Ai Services",
      "Sample page",
    ]);
  });

  it("skips parent segments that aren't pages (static routes and the given CMS parents are)", () => {
    const names = (path: string, parents: string[] = []) =>
      (
        buildJsonLd(doc(), path, parents)[0]!.itemListElement as {
          name: string;
        }[]
      ).map((i) => i.name);
    expect(names("/ai-services/sample")).toEqual(["Home", "Sample page"]);
    expect(names("/guides/a/sample", ["guides/a"])).toEqual([
      "Home",
      "A",
      "Sample page",
    ]);
    expect(
      names("/services/automation-sprint/faq", [
        "services",
        "services/automation-sprint",
      ])
    ).toEqual(["Home", "Services", "Automation Sprint", "Sample page"]);
    // Static routes are pages without being listed (this site's only static pages are login ones).
    expect(names("/login/sample")).toEqual(["Home", "Login", "Sample page"]);
  });

  it("has no breadcrumbs on the home page", () => {
    const nodes = buildJsonLd(doc(), "/");
    expect(nodes[0]!["@type"]).toBe("WebPage");
    expect(nodes[0]!.url).toBe(BASE);
  });
});

describe("buildHead with the site doc's SEO defaults", () => {
  const site = (patch: (s: PublicSiteSeo) => void): PublicSiteSeo => {
    const s = structuredClone(DEFAULT_SEO);
    patch(s);
    return s;
  };

  it("is unchanged with the defaults passed explicitly", () => {
    expect(buildHead(doc(), "/x", DEFAULT_SEO)).toEqual(buildHead(doc(), "/x"));
  });

  it("applies the title template unless the title is exact", () => {
    const s = site((x) => (x.titleTemplate = "ACME — %s"));
    expect(meta(buildHead(doc(), "/x", s), "title")).toBe("ACME — Sample page");
    expect(meta(buildHead(doc(), "/x", s), "og:title")).toBe(
      "ACME — Sample page"
    );
    expect(
      meta(
        buildHead(
          doc((d) => (d.seo.titleExact = true)),
          "/x",
          s
        ),
        "title"
      )
    ).toBe("Sample page");
    // `$&` in a title is literal text, not a replacement pattern.
    expect(
      meta(
        buildHead(
          doc((d) => (d.seo.title = "Save $& more")),
          "/x",
          s
        ),
        "title"
      )
    ).toBe("ACME — Save $& more");
  });

  it("uses the site's twitter:card", () => {
    expect(
      meta(
        buildHead(
          doc(),
          "/x",
          site((x) => (x.twitterCard = "summary"))
        ),
        "twitter:card"
      )
    ).toBe("summary");
  });

  it("uses the default share image from the library, with its size and alt, when the page has none", () => {
    const s = site(
      (x) =>
        (x.defaultShareImage = {
          mediaId: MEDIA_ID,
          url: "/og-image.jpg",
          alt: "ACME logo card",
          width: 1200,
          height: 630,
        })
    );
    const head = buildHead(doc(), "/x", s);
    expect(meta(head, "og:image")).toBe(`${BASE}/media/${MEDIA_ID}`);
    expect(meta(head, "twitter:image")).toBe(`${BASE}/media/${MEDIA_ID}`);
    expect(meta(head, "og:image:width")).toBe("1200");
    expect(meta(head, "og:image:height")).toBe("630");
    expect(meta(head, "og:image:alt")).toBe("ACME logo card");
    expect(meta(head, "twitter:image:alt")).toBe("ACME logo card");
    // The page's own image still wins.
    const own = buildHead(
      doc(
        (d) =>
          (d.seo.social.image = {
            mediaId: "b".repeat(64) + ".png",
            alt: "Own",
          })
      ),
      "/x",
      s
    );
    expect(meta(own, "og:image:alt")).toBe("Own");
  });

  it("uses the fallback URL (absolute) without size tags", () => {
    const head = buildHead(
      doc(),
      "/x",
      site(
        (x) => (x.defaultShareImage = { url: "/cards/default.png", alt: "" })
      )
    );
    expect(meta(head, "og:image")).toBe(`${BASE}/cards/default.png`);
    expect(meta(head, "og:image:width")).toBeUndefined();
    expect(meta(head, "og:image:alt")).toBeUndefined();
    const external = buildHead(
      doc(),
      "/x",
      site(
        (x) =>
          (x.defaultShareImage = {
            url: "https://cdn.example/c.png",
            alt: "Card",
          })
      )
    );
    expect(meta(external, "og:image")).toBe("https://cdn.example/c.png");
    expect(meta(external, "og:image:alt")).toBe("Card");
  });
});
