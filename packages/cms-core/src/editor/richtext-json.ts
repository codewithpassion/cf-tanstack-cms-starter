import type {
  List,
  ListItem,
  Paragraph,
  RichTextDoc,
  RichTextMark,
  RichTextNode,
  RichTextText,
} from "../richtext/schema";

/**
 * TipTap JSON → the restricted rich-text schema (app/cms/richtext/schema.ts). TipTap adds things the
 * schema doesn't allow (link target/rel/class, `orderedList.type`, empty text, nodes from pasted
 * HTML); stripping them here keeps the editor's local document identical to what the server stores.
 * The result still goes through `richTextSchema` before it's used (unsafe hrefs fail there).
 */

type JsonNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

export function sanitizeRichText(json: JsonNode): RichTextDoc {
  return { type: "doc", content: (json.content ?? []).flatMap(topLevel) };
}

function topLevel(node: JsonNode): RichTextNode[] {
  switch (node.type) {
    case "heading": {
      const raw = Number(node.attrs?.level);
      const level = raw >= 3 ? 3 : 2;
      return [
        withContent(
          { type: "heading", attrs: { level } },
          inline(node.content)
        ),
      ];
    }
    case "paragraph":
    case "bulletList":
    case "orderedList":
      return nested(node);
    case "blockquote": {
      const content = (node.content ?? []).flatMap(nested);
      return content.length ? [{ type: "blockquote", content }] : [];
    }
    default:
      // Anything else (a pasted code block, rule, …) degrades to its text as a paragraph.
      return textParagraph(node);
  }
}

/** Paragraphs and lists: what list items and blockquotes may contain. */
function nested(node: JsonNode): (Paragraph | List)[] {
  switch (node.type) {
    case "paragraph":
      return [withContent({ type: "paragraph" }, inline(node.content))];
    case "heading":
      return [withContent({ type: "paragraph" }, inline(node.content))];
    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? []).flatMap(listItem);
      if (!items.length) {
        return [];
      }
      if (node.type === "bulletList") {
        return [{ type: "bulletList", content: items }];
      }
      const start = Number(node.attrs?.start);
      return [
        {
          type: "orderedList",
          ...(Number.isInteger(start) &&
            start >= 0 &&
            start !== 1 && { attrs: { start } }),
          content: items,
        },
      ];
    }
    default:
      return textParagraph(node);
  }
}

function listItem(node: JsonNode): ListItem[] {
  if (node.type !== "listItem") {
    return [];
  }
  const content = (node.content ?? []).flatMap(nested);
  return [
    {
      type: "listItem",
      content: content.length ? content : [{ type: "paragraph" }],
    },
  ];
}

function withContent<T extends { type: string }>(
  node: T,
  content: RichTextText[]
): T & { content?: RichTextText[] } {
  return content.length ? { ...node, content } : node;
}

function inline(content: JsonNode[] | undefined): RichTextText[] {
  const out: RichTextText[] = [];
  for (const node of content ?? []) {
    if (node.type !== "text" || typeof node.text !== "string" || !node.text) {
      continue;
    }
    const marks = (node.marks ?? []).flatMap(mark);
    out.push(
      marks.length
        ? { type: "text", text: node.text, marks }
        : { type: "text", text: node.text }
    );
  }
  return out;
}

function mark(m: {
  type?: string;
  attrs?: Record<string, unknown>;
}): RichTextMark[] {
  switch (m.type) {
    case "bold":
    case "italic":
    case "code":
      return [{ type: m.type }];
    case "link":
      return typeof m.attrs?.href === "string"
        ? [{ type: "link", attrs: { href: m.attrs.href } }]
        : [];
    default:
      return [];
  }
}

function plainText(node: JsonNode): string {
  if (node.type === "text") {
    return node.text ?? "";
  }
  return (node.content ?? []).map(plainText).join("");
}

function textParagraph(node: JsonNode): Paragraph[] {
  const text = plainText(node);
  return text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [];
}
