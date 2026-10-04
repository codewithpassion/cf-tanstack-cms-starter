import { describe, expect, it } from "bun:test";

import { nth } from "../ops/test-docs";
import { richTextToPlainText } from "./plain-text";
import { type RichTextDoc, richTextSchema } from "./schema";

const doc: RichTextDoc = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Title" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        {
          type: "text",
          text: "world",
          marks: [
            { type: "bold" },
            { type: "link", attrs: { href: "/about" } },
          ],
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "One" }] },
          ],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Two" }] },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Quote" }] },
      ],
    },
  ],
};

describe("richTextSchema", () => {
  it("accepts the supported nodes and TipTap's extra link attrs", () => {
    const withTipTapAttrs = structuredClone(doc) as unknown as {
      content: { content?: { marks?: { attrs?: object }[] }[] }[];
    };
    nth(nth(nth(withTipTapAttrs.content, 1).content, 1).marks, 1).attrs = {
      href: "/about",
      target: "_blank",
      rel: null,
      class: null,
    };
    expect(richTextSchema.safeParse(withTipTapAttrs).success).toBe(true);
  });

  it("rejects h1, raw HTML nodes, unknown marks and javascript: links", () => {
    const bad = [
      {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 }, content: [] }],
      },
      {
        type: "doc",
        content: [{ type: "html", html: "<script>alert(1)</script>" }],
      },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "x", marks: [{ type: "underline" }] },
            ],
          },
        ],
      },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [
                  { type: "link", attrs: { href: "javascript:alert(1)" } },
                ],
              },
            ],
          },
        ],
      },
    ];
    for (const value of bad) {
      expect(richTextSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("richTextToPlainText", () => {
  it("joins blocks with blank lines and list items with newlines", () => {
    expect(richTextToPlainText(doc)).toBe(
      "Title\n\nHello world\n\nOne\nTwo\n\nQuote"
    );
  });
});
