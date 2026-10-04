// biome-ignore-all lint/suspicious/noMisplacedAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import { type RichTextDoc, richTextSchema } from "../richtext/schema";
import { canonicalRichText, fromMarkdown, toMarkdown } from "./markdown";

const t = (
  text: string,
  ...marks: RichTextDoc["content"][number] extends never ? never : any[]
) =>
  marks.length
    ? { type: "text" as const, text, marks }
    : { type: "text" as const, text };
const p = (...content: any[]) =>
  content.length
    ? { type: "paragraph" as const, content }
    : { type: "paragraph" as const };
const li = (...content: any[]) => ({ type: "listItem" as const, content });
const B = { type: "bold" };
const I = { type: "italic" };
const C = { type: "code" };
const L = (href: string) => ({ type: "link", attrs: { href } });

function roundTrip(doc: RichTextDoc) {
  // Fixtures must be valid documents in the restricted schema.
  expect(richTextSchema.safeParse(doc).success).toBe(true);
  const md = toMarkdown(doc);
  const back = fromMarkdown(md);
  expect(back, md).toEqual(canonicalRichText(doc));
  expect(richTextSchema.safeParse(back).success).toBe(true);
  return md;
}

describe("rich text ↔ Markdown round trip", () => {
  it("paragraphs and headings", () => {
    const md = roundTrip({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [t("Why teams stall")],
        },
        p(t("Most AI pilots fail on adoption, not tooling.")),
        { type: "heading", attrs: { level: 3 }, content: [t("The fix")] },
        p(t("Second paragraph.")),
      ],
    });
    expect(md).toBe(
      "## Why teams stall\n\nMost AI pilots fail on adoption, not tooling.\n\n### The fix\n\nSecond paragraph."
    );
  });

  it("marks, combined and adjacent", () => {
    const md = roundTrip({
      type: "doc",
      content: [
        p(
          t("Plain "),
          t("bold", B),
          t(" and "),
          t("italic", I),
          t(", "),
          t("both", B, I),
          t(" then "),
          t("bold", B),
          t("+italic", B, I),
          t(" and "),
          t("bi", I, B),
          t("b", B),
          t(" code ", C),
          t("x")
        ),
      ],
    });
    expect(md).toContain("**bold**");
    expect(md).toContain("`  code  `");
  });

  it("links, including marks inside and awkward hrefs", () => {
    roundTrip({
      type: "doc",
      content: [
        p(
          t("See "),
          t("our services", L("/services")),
          t(" or "),
          t("email", B, L("mailto:hi@example.com")),
          t(".")
        ),
        p(
          t("Odd ", L("https://example.com/a_(b)")),
          t("link", B, L("https://example.com/a_(b)"))
        ),
        p(t("Anchor", L("#faq"))),
      ],
    });
  });

  it("escapes Markdown syntax in text", () => {
    const md = roundTrip({
      type: "doc",
      content: [
        p(t("# not a heading")),
        p(t("- not a list")),
        p(t("1. not a list either")),
        p(t("> not a quote")),
        p(
          t(
            "2 * 3 = 6 and a_b_c, [brackets] and \\ backslash, <tag> and `ticks`"
          )
        ),
        p(t("code with `backticks` inside", C)),
        p(t("+ plus")),
      ],
    });
    expect(fromMarkdown(md).content).toHaveLength(7);
  });

  it("nested lists, ordered start and multi-paragraph items", () => {
    roundTrip({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            li(p(t("One"))),
            li(p(t("Two")), {
              type: "orderedList",
              content: [
                li(p(t("Two a"))),
                li(p(t("Two b")), {
                  type: "bulletList",
                  content: [li(p(t("deep")))],
                }),
              ],
            }),
            li(p(t("Three")), p(t("Second paragraph of three"))),
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [li(p(t("Third"))), li(p(t("Fourth", B)))],
        },
        {
          type: "orderedList",
          content: Array.from({ length: 11 }, (_, i) =>
            li(p(t(`Item ${i + 1}`)))
          ),
        },
      ],
    });
  });

  it("blockquotes with paragraphs and lists", () => {
    roundTrip({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            p(t("Quoted ")),
            p(t("again", I)),
            { type: "bulletList", content: [li(p(t("in a quote")))] },
          ],
        },
        p(t("after")),
      ],
    });
  });

  it("empty paragraphs and an empty document", () => {
    roundTrip({ type: "doc", content: [p(), p(t("x")), p()] });
    roundTrip({ type: "doc", content: [] });
  });
});

describe("Markdown a model writes", () => {
  it("degrades what the schema doesn't allow", () => {
    const doc = fromMarkdown(
      "# Title\n\n#### Deep\n\n---\n\n```\nnpm i\n```\n\n* star item\n* another\n\n- [x] task"
    );
    expect(richTextSchema.safeParse(doc).success).toBe(true);
    expect(doc.content[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [t("Title")],
    });
    expect(doc.content[1]).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: [t("Deep")],
    });
    expect(doc.content[2]).toEqual(p(t("npm i", C)));
    expect(doc.content[3]).toMatchObject({
      type: "bulletList",
      content: [{}, {}],
    });
  });

  it("joins soft-wrapped lines and reads underscores and autolinks", () => {
    const doc = fromMarkdown(
      "A line\nwrapped here with __bold__ and _it_ and snake_case_name.\n\n<https://example.com>"
    );
    expect(doc.content[0]).toEqual(
      p(
        t("A line wrapped here with "),
        t("bold", B),
        t(" and "),
        t("it", I),
        t(" and snake_case_name.")
      )
    );
    expect(doc.content[1]).toEqual(
      p(t("https://example.com", L("https://example.com")))
    );
  });

  it("headings inside lists and quotes become paragraphs", () => {
    const doc = fromMarkdown("- ## Heading item\n\n> ### quoted heading");
    expect(richTextSchema.safeParse(doc).success).toBe(true);
    expect(doc.content[0]).toEqual({
      type: "bulletList",
      content: [li(p(t("Heading item")))],
    });
    expect(doc.content[1]).toEqual({
      type: "blockquote",
      content: [p(t("quoted heading"))],
    });
  });

  it("loose lists stay one list", () => {
    const doc = fromMarkdown("1. First\n\n2. Second\n\n3. Third");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toMatchObject({
      type: "orderedList",
      content: [{}, {}, {}],
    });
  });
});
