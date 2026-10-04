import { describe, expect, it } from "bun:test";

import { richTextSchema } from "../richtext/schema";
import { sanitizeRichText } from "./richtext-json";

describe("sanitizeRichText", () => {
  it("keeps the allowed schema and strips TipTap extras", () => {
    const out = sanitizeRichText({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, id: "x" },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A " },
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "/contact",
                    target: "_blank",
                    rel: "noopener",
                    class: null,
                  },
                },
                { type: "bold" },
                { type: "underline" },
              ],
            },
            { type: "text", text: "" },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 1, type: null },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One" }] },
              ],
            },
          ],
        },
        { type: "paragraph" },
      ],
    });
    expect(out).toEqual({
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
            { type: "text", text: "A " },
            {
              type: "text",
              text: "link",
              marks: [
                { type: "link", attrs: { href: "/contact" } },
                { type: "bold" },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One" }] },
              ],
            },
          ],
        },
        { type: "paragraph" },
      ],
    });
    expect(richTextSchema.safeParse(out).success).toBe(true);
  });

  it("degrades disallowed nodes: h1 → h2, h4 → h3, heading in a blockquote → paragraph, code block → paragraph", () => {
    const out = sanitizeRichText({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "a" }],
        },
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "b" }],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "c" }],
            },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "d" }] },
        { type: "horizontalRule" },
      ],
    });
    expect(out.content.map((n) => n.type)).toEqual([
      "heading",
      "heading",
      "blockquote",
      "paragraph",
    ]);
    expect(out.content[0]).toMatchObject({ attrs: { level: 2 } });
    expect(out.content[1]).toMatchObject({ attrs: { level: 3 } });
    expect(out.content[2]).toEqual({
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
    });
    expect(richTextSchema.safeParse(out).success).toBe(true);
  });

  it("leaves unsafe links for the schema to reject", () => {
    const out = sanitizeRichText({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    });
    expect(richTextSchema.safeParse(out).success).toBe(false);
  });
});
