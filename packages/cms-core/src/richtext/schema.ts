import { z } from "zod";

import { hrefSchema } from "../links";

/**
 * Restricted TipTap/ProseMirror JSON: paragraphs, h2/h3, bullet and
 * ordered lists, blockquote; marks bold, italic, inline code and link. No raw HTML.
 * Link attrs other than `href` (TipTap adds target/rel/class) are accepted and dropped.
 */

const markSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("bold") }),
  z.strictObject({ type: z.literal("italic") }),
  z.strictObject({ type: z.literal("code") }),
  z.strictObject({
    type: z.literal("link"),
    attrs: z.object({ href: hrefSchema }),
  }),
]);

const textSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().min(1),
  marks: z.array(markSchema).optional(),
});

const inline = z.array(textSchema).optional();

const paragraphSchema = z.strictObject({
  type: z.literal("paragraph"),
  content: inline,
});

const headingSchema = z.strictObject({
  type: z.literal("heading"),
  attrs: z.object({ level: z.union([z.literal(2), z.literal(3)]) }),
  content: inline,
});

type ListItem = { type: "listItem"; content: (Paragraph | List)[] };
type List =
  | { type: "bulletList"; content: ListItem[] }
  | { type: "orderedList"; attrs?: { start?: number }; content: ListItem[] };

const listItemSchema: z.ZodType<ListItem> = z.strictObject({
  type: z.literal("listItem"),
  get content() {
    return z.array(z.union([paragraphSchema, listSchema])).min(1);
  },
});

const listSchema: z.ZodType<List> = z.union([
  z.strictObject({
    type: z.literal("bulletList"),
    content: z.array(listItemSchema).min(1),
  }),
  z.strictObject({
    type: z.literal("orderedList"),
    attrs: z.object({ start: z.number().int().min(0).optional() }).optional(),
    content: z.array(listItemSchema).min(1),
  }),
]);

const blockquoteSchema = z.strictObject({
  type: z.literal("blockquote"),
  content: z.array(z.union([paragraphSchema, listSchema])).min(1),
});

const topLevelSchema = z.union([
  paragraphSchema,
  headingSchema,
  listSchema,
  blockquoteSchema,
]);

const richTextDocSchema = z.strictObject({
  type: z.literal("doc"),
  content: z.array(topLevelSchema),
});

export const MAX_LIST_DEPTH = 4;
/** Nodes below `doc`: 4 lists inside a blockquote, down to the text, reach 11. */
export const MAX_RICH_TEXT_DEPTH = 12;

/**
 * Iterative depth scan along `content` arrays, run before the recursive Zod schema so a hostile
 * document can't overflow the stack. Reports the first offending node only.
 */
function checkDepth(ctx: z.core.ParsePayload<unknown>) {
  type Frame = {
    node: unknown;
    depth: number;
    lists: number;
    path: (string | number)[];
  };
  const stack: Frame[] = [{ node: ctx.value, depth: 0, lists: 0, path: [] }];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { node, depth, lists, path } = frame;
    const content = (node as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let i = 0; i < content.length; i += 1) {
      const child = content[i] as { type?: unknown } | null;
      const childPath = [...path, "content", i];
      const childLists =
        lists +
        (child?.type === "bulletList" || child?.type === "orderedList" ? 1 : 0);
      let message: string | null = null;
      if (childLists > MAX_LIST_DEPTH) {
        message = `Lists can't be nested more than ${MAX_LIST_DEPTH} deep`;
      } else if (depth + 1 > MAX_RICH_TEXT_DEPTH) {
        message = "Rich text is nested too deeply";
      }
      if (message) {
        ctx.issues.push({
          code: "custom",
          message,
          input: child,
          path: childPath,
        });
        return;
      }
      stack.push({
        node: child,
        depth: depth + 1,
        lists: childLists,
        path: childPath,
      });
    }
  }
}

export const richTextSchema = z
  .unknown()
  .check(checkDepth)
  .pipe(richTextDocSchema);

export type RichTextMark = z.infer<typeof markSchema>;
export type RichTextText = z.infer<typeof textSchema>;
export type Paragraph = z.infer<typeof paragraphSchema>;
export type Heading = z.infer<typeof headingSchema>;
export type Blockquote = z.infer<typeof blockquoteSchema>;
export type { List, ListItem };
export type RichTextNode = Paragraph | Heading | List | Blockquote;
export type RichTextDoc = z.infer<typeof richTextDocSchema>;

/** A one-paragraph document, handy for block defaults. */
export function richTextFromString(text: string): RichTextDoc {
  return {
    type: "doc",
    content: [
      text
        ? { type: "paragraph", content: [{ type: "text", text }] }
        : { type: "paragraph" },
    ],
  };
}
