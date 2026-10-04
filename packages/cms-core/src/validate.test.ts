import { describe, expect, it } from "bun:test";

import { hero } from "./blocks/hero";
import { listBlockDefs, migrateProps } from "./blocks/registry";
import { isSafeHref } from "./links";
import { nth } from "./ops/test-docs";
import { collectJsonLd } from "./render/json-ld";
import { MEDIA_ID, sampleDoc } from "./test-fixtures";
import type { PageDoc } from "./types";
import { MAX_DOC_BYTES, pageLimitErrors, validatePageDoc } from "./validate";

const LIST_DEPTH_PATH_RE = /^blocks\[0\]\.props\.body\.content\[0\]/;
const TOO_LARGE_RE = /too large to save/;
const LIST_TOO_DEEP_RE = /nested more than 4 deep/;
const TOO_DEEP_RE = /nested too deeply/;

function errorsOf(doc: unknown) {
  const result = validatePageDoc(doc);
  if (result.ok) {
    throw new Error("expected validation to fail");
  }
  return result.errors;
}

const paths = (doc: unknown) => errorsOf(doc).map((e) => e.path);

describe("validatePageDoc", () => {
  it("rejects a canonical URL with a malformed %-escape, and accepts a well-formed one", () => {
    const withCanonical = (canonical: string) => ({
      ...sampleDoc(),
      seo: { ...sampleDoc().seo, canonical },
    });
    expect(paths(withCanonical("https://example.com/%E0"))).toEqual([
      "seo.canonical",
    ]);
    expect(
      validatePageDoc(withCanonical("https://example.com/caf%C3%A9")).ok
    ).toBe(true);
  });

  it("accepts the sample doc and returns it normalised", () => {
    const result = validatePageDoc(sampleDoc());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(sampleDoc());
    }
  });

  it("accepts every block's defaults", () => {
    const doc = sampleDoc();
    doc.blocks = listBlockDefs().map((def, i) => ({
      _key: `k${i}`,
      _type: def.type,
      _v: def.version,
      props: def.defaults(),
    }));
    expect(validatePageDoc(doc)).toMatchObject({ ok: true });
  });

  it("reports nested prop paths", () => {
    const doc = sampleDoc();
    nth(
      (nth(doc.blocks, 1).props as { items: { title: string }[] }).items,
      0
    ).title = "";
    expect(paths(doc)).toEqual(["blocks[1].props.items[0].title"]);
  });

  it("reports unknown block types at _type", () => {
    const doc = sampleDoc();
    doc.blocks.splice(1, 0, { _key: "x", _type: "carousel", _v: 1, props: {} });
    expect(errorsOf(doc)).toEqual([
      { path: "blocks[1]._type", message: 'Unknown block type "carousel"' },
    ]);
  });

  it("rejects unsafe links", () => {
    const doc = sampleDoc();
    (nth(doc.blocks, 0).props as { primary: { href: string } }).primary.href =
      "javascript:alert(1)";
    expect(paths(doc)).toEqual(["blocks[0].props.primary.href"]);
  });

  it("rejects unsafe links inside rich text", () => {
    const doc = sampleDoc();
    const { a } = nth(
      (
        nth(doc.blocks, 2).props as {
          items: { a: { content: { content: { marks?: unknown[] }[] }[] } }[];
        }
      ).items,
      0
    );
    nth(nth(a.content, 0).content, 1).marks = [
      { type: "link", attrs: { href: "javascript:alert(1)" } },
    ];
    expect(paths(doc)).toEqual([
      "blocks[2].props.items[0].a.content[0].content[1].marks[0].attrs.href",
    ]);
  });

  it("reports style errors and unknown element names", () => {
    const doc = sampleDoc();
    nth(doc.blocks, 0).style = { padding: { desktop: { top: -5 } } };
    nth(doc.blocks, 3).style = {
      elements: { sidebar: { hide: { mobile: true } } },
    };
    expect(paths(doc)).toEqual([
      "blocks[0].style.padding.desktop.top",
      "blocks[3].style.elements.sidebar",
    ]);
  });

  it("rejects element style properties the element doesn't honour", () => {
    const doc = sampleDoc();
    // FAQ items: the question and answer set their own colour and size, so only align and hide apply.
    nth(doc.blocks, 2).style = {
      elements: {
        heading: { color: { token: "white" } },
        items: { color: { token: "white" }, align: { desktop: "center" } },
      },
    };
    expect(errorsOf(doc)).toEqual([
      {
        path: "blocks[2].style.elements.items.color",
        message:
          '"faq" element "items" does not support "color" (supported: align, hide)',
      },
    ]);
  });

  it("reports duplicate keys for blocks and items", () => {
    const doc = sampleDoc();
    nth(doc.blocks, 3)._key = "hero1";
    nth(
      (nth(doc.blocks, 1).props as { items: { _key: string }[] }).items,
      1
    )._key = "a";
    expect(paths(doc)).toEqual([
      "blocks[1].props.items[1]._key",
      "blocks[3]._key",
    ]);
  });

  it("validates seo, post and the envelope, and still checks blocks", () => {
    const doc = sampleDoc() as unknown as Record<string, unknown> & PageDoc;
    doc.seo.title = "";
    doc.seo.slug = "Not A Slug";
    doc.post = {
      excerpt: "",
      author: "Dom",
      publishedAt: "yesterday",
      category: "AI",
      tags: [],
      readingTime: 3,
    };
    doc.extra = true;
    (nth(doc.blocks, 0).props as { heading: string }).heading = "";
    expect(paths(doc).sort()).toEqual(
      [
        "",
        "blocks[0].props.heading",
        "post.publishedAt",
        "seo.slug",
        "seo.title",
      ].sort()
    );
    expect(paths({ _schema: 2, seo: {}, blocks: "nope" })).toContain("_schema");
  });

  it("accepts `_override` on schema.extra nodes only as a list of page-derived keys", () => {
    const withOverride = (override: unknown) => {
      const doc = sampleDoc();
      doc.seo.schema.extra = [{ "@type": "Service", _override: override }];
      return doc;
    };
    expect(validatePageDoc(withOverride(["name", "description"])).ok).toBe(
      true
    );
    expect(paths(withOverride(["offers"]))).toEqual([
      "seo.schema.extra[0]._override",
    ]);
    expect(paths(withOverride("name"))).toEqual([
      "seo.schema.extra[0]._override",
    ]);
  });

  it("validates image media ids", () => {
    const doc = sampleDoc();
    doc.blocks = [
      {
        _key: "img",
        _type: "image",
        _v: 1,
        props: { mediaId: "../../etc/passwd", alt: "x" },
      },
    ];
    expect(paths(doc)).toEqual(["blocks[0].props.mediaId"]);
    nth(doc.blocks, 0).props = { mediaId: MEDIA_ID, alt: "A river" };
    expect(validatePageDoc(doc).ok).toBe(true);
  });
});

describe("pageLimitErrors (the editor's per-edit check)", () => {
  it("is empty for a doc within the limits", () => {
    expect(pageLimitErrors(sampleDoc(), { seo: true })).toEqual([]);
  });

  it("reports too many blocks, too many bytes, and (when asked) invalid SEO", () => {
    const doc = sampleDoc();
    const cta = nth(doc.blocks, 3);
    doc.blocks = Array.from({ length: 201 }, (_, i) => ({
      ...cta,
      _key: `c${i}`,
    }));
    expect(pageLimitErrors(doc)).toEqual([
      { path: "blocks", message: "A page can have at most 200 blocks" },
    ]);

    const big = sampleDoc();
    big.blocks[3] = {
      ...cta,
      props: { heading: "é".repeat(MAX_DOC_BYTES / 2) },
    };
    expect(pageLimitErrors(big)).toEqual([
      { path: "", message: expect.stringMatching(TOO_LARGE_RE) },
    ]);

    const seo = sampleDoc();
    seo.seo.title = "";
    expect(pageLimitErrors(seo)).toEqual([]);
    expect(nth(pageLimitErrors(seo, { seo: true }), 0).path).toBe("seo.title");
  });
});

describe("validatePageDoc limits", () => {
  type Node = { type: string; content?: Node[]; text?: string };
  const para = (): Node => ({
    type: "paragraph",
    content: [{ type: "text", text: "x" }],
  });
  /** `depth` bullet lists nested inside each other. */
  function nestedLists(depth: number): Node {
    let node: Node = {
      type: "bulletList",
      content: [{ type: "listItem", content: [para()] }],
    };
    for (let i = 1; i < depth; i += 1) {
      node = {
        type: "bulletList",
        content: [{ type: "listItem", content: [para(), node] }],
      };
    }
    return node;
  }
  const withBody = (...content: Node[]) => {
    const doc = sampleDoc();
    doc.blocks = [
      {
        _key: "rt",
        _type: "richText",
        _v: 1,
        props: { body: { type: "doc", content } },
      },
    ];
    return doc;
  };

  it("allows lists nested 4 deep (inside a blockquote) and rejects 5", () => {
    expect(
      validatePageDoc(
        withBody({ type: "blockquote", content: [nestedLists(4)] })
      ).ok
    ).toBe(true);
    const errors = errorsOf(withBody(nestedLists(5)));
    expect(errors).toHaveLength(1);
    expect(nth(errors, 0).path).toMatch(LIST_DEPTH_PATH_RE);
    expect(nth(errors, 0).message).toMatch(LIST_TOO_DEEP_RE);
  });

  it("rejects pathologically deep rich text without throwing", () => {
    expect(() => validatePageDoc(withBody(nestedLists(10_000)))).not.toThrow();
    expect(errorsOf(withBody(nestedLists(10_000)))).toHaveLength(1);

    let deep: Node = para();
    for (let i = 0; i < 10_000; i += 1) {
      deep = { type: "paragraph", content: [deep] };
    }
    const errors = errorsOf(withBody(deep));
    expect(errors).toHaveLength(1);
    expect(nth(errors, 0).message).toMatch(TOO_DEEP_RE);
  });

  it("caps blocks per page at 200 and skips per-block checks beyond that", () => {
    const doc = sampleDoc();
    const cta = nth(doc.blocks, 3);
    doc.blocks = Array.from({ length: 201 }, (_, i) => ({
      ...cta,
      _key: `c${i}`,
      props: {},
    }));
    expect(errorsOf(doc)).toEqual([
      { path: "blocks", message: "A page can have at most 200 blocks" },
    ]);
    doc.blocks = doc.blocks
      .slice(0, 200)
      .map((b) => ({ ...b, props: cta.props }));
    expect(validatePageDoc(doc).ok).toBe(true);
  });

  it("never throws, even on hostile input", () => {
    const hostile = {
      _schema: 1,
      get seo(): never {
        throw new Error("boom");
      },
      blocks: [],
    };
    expect(validatePageDoc(hostile)).toEqual({
      ok: false,
      errors: [{ path: "", message: "Document could not be validated: boom" }],
    });
  });
});

describe("migrateProps", () => {
  const v2 = {
    ...hero,
    version: 2,
    migrate: { 1: (old: object) => ({ ...old, migrated: true }) },
  };

  it("runs migrations up to the current version", () => {
    expect(migrateProps(v2, 1, { a: 1 })).toEqual({
      ok: true,
      props: { a: 1, migrated: true },
    });
  });

  it("refuses versions newer than the definition", () => {
    expect(migrateProps(hero, 2, {})).toMatchObject({ ok: false });
  });
});

describe("isSafeHref", () => {
  it.each([
    "/contact",
    "/",
    "#faq",
    "?q=1",
    "https://example.com/x",
    "mailto:hi@example.com",
    "tel:+61 400 000 000",
  ])("allows %s", (href) => expect(isSafeHref(href)).toBe(true));
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,x",
    "http://example.com",
    "//evil.com",
    "/\\evil.com",
    "contact",
    "",
  ])("rejects %j", (href) => expect(isSafeHref(href)).toBe(false));
});

describe("collectJsonLd", () => {
  it("emits FAQPage from the faq block with plain-text answers", () => {
    expect(collectJsonLd(sampleDoc())).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is it?",
            acceptedAnswer: { "@type": "Answer", text: "It is great." },
          },
        ],
      },
    ]);
  });

  it("skips a block when the element its JSON-LD describes is hidden on every device", () => {
    const doc = sampleDoc();
    nth(doc.blocks, 2).style = {
      elements: {
        items: { hide: { desktop: true, tablet: true, mobile: true } },
      },
    };
    expect(collectJsonLd(doc)).toEqual([]);
    // Hide cascades down: desktop alone hides every device, an explicit false un-hides one.
    nth(doc.blocks, 2).style = {
      elements: { items: { hide: { desktop: true } } },
    };
    expect(collectJsonLd(doc)).toEqual([]);
    nth(doc.blocks, 2).style = {
      elements: {
        items: { hide: { desktop: true, tablet: true, mobile: false } },
      },
    };
    expect(collectJsonLd(doc)).toHaveLength(1);
  });

  it("skips invalid blocks and blocks hidden on every device", () => {
    const doc = sampleDoc();
    nth(doc.blocks, 2).style = {
      hide: { desktop: true, tablet: true, mobile: true },
    };
    expect(collectJsonLd(doc)).toEqual([]);

    const invalid = sampleDoc();
    (nth(invalid.blocks, 2).props as { items: unknown[] }).items = [];
    expect(collectJsonLd(invalid)).toEqual([]);
  });
});

describe("post metadata", () => {
  const postDoc = (
    post: Partial<NonNullable<PageDoc["post"]>> = {},
    slug = "blog/x"
  ): PageDoc => {
    const doc = sampleDoc();
    doc.seo.slug = slug;
    doc.post = {
      excerpt: "",
      author: "Dom",
      publishedAt: "2026-09-01",
      category: "AI",
      tags: [],
      readingTime: 0,
      ...post,
    };
    return doc;
  };
  const postPaths = (d: PageDoc) => {
    const r = validatePageDoc(d);
    return r.ok ? [] : r.errors.map((e) => e.path);
  };

  it("accepts a title, a reading time override and the auto-date flag", () => {
    expect(
      postPaths(
        postDoc({ title: "T", readingTimeOverride: 9, publishedAtAuto: true })
      )
    ).toEqual([]);
    expect(postPaths(postDoc({ title: "", readingTimeOverride: 0 }))).toEqual([
      "post.title",
      "post.readingTimeOverride",
    ]);
  });

  it("refuses an updated date before the published date (compared as days)", () => {
    expect(postPaths(postDoc({ modifiedAt: "2026-08-31" }))).toEqual([
      "post.modifiedAt",
    ]);
    expect(postPaths(postDoc({ modifiedAt: "2026-09-01" }))).toEqual([]);
    expect(
      postPaths(
        postDoc({
          publishedAt: "2026-09-01T23:00:00+10:00",
          modifiedAt: "2026-09-01",
        })
      )
    ).toEqual([]);
  });

  it("refuses a post slug deeper than blog/<slug>, on save and per edit", () => {
    expect(postPaths(postDoc({}, "blog/a/b"))).toEqual(["seo.slug"]);
    expect(
      pageLimitErrors(postDoc({}, "blog/a/b"), { seo: true }).map((e) => e.path)
    ).toEqual(["seo.slug"]);
    expect(pageLimitErrors(postDoc({}, "blog/a/b"))).toEqual([]);
  });

  it("checks post metadata per edit when asked", () => {
    expect(
      pageLimitErrors(postDoc({ modifiedAt: "2026-01-01" }), {
        post: true,
      }).map((e) => e.path)
    ).toEqual(["post.modifiedAt"]);
    expect(pageLimitErrors(postDoc({ modifiedAt: "2026-01-01" }))).toEqual([]);
  });
});
