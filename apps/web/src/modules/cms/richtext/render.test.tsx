import { describe, expect, it } from "bun:test";
import type { RichTextDoc } from "@repo/cms-core/richtext/schema";
import { renderToString } from "react-dom/server";

import { RichText } from "./render";

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

describe("RichText", () => {
  it("renders bullet lists as ✓ rows with `bullets: check`, as a disc list otherwise", () => {
    const check = renderToString(<RichText bullets="check" doc={doc} />);
    expect(check.match(/aria-hidden="true">✓<\/span>/g)?.length).toBe(2);
    expect(check).not.toContain("list-disc");
    expect(renderToString(<RichText doc={doc} />)).toContain("list-disc");
  });

  it("uses the article typography for a post body", () => {
    const html = renderToString(<RichText doc={doc} variant="article" />);
    expect(html.match(/►/g)?.length).toBe(2);
    expect(html).toContain("cyber-border");
  });

  it("renders the supported nodes", () => {
    const html = renderToString(<RichText doc={doc} />);
    expect(html).toContain("<h2");
    expect(html).toContain('<a href="/about"');
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<blockquote");
  });

  it("escapes text and drops unsafe links even when the doc skipped validation", () => {
    const evil = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "<script>alert(1)</script>" },
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
        { type: "html", html: "<img src=x onerror=alert(1)>" },
      ],
    } as unknown as RichTextDoc;
    const html = renderToString(<RichText doc={evil} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("onerror");
    expect(html).toContain("click");
  });
});
