import { z } from "zod";
import { richTextFromString, richTextSchema } from "../richtext/schema";
import { defineBlock } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().max(200).optional(),
  body: richTextSchema,
});

type Props = z.output<typeof schema>;

export const callout = defineBlock({
  type: "callout",
  version: 1,
  label: "Callout",
  icon: "message-square-quote",
  category: "content",
  schema,
  defaults: (): Props => ({
    body: richTextFromString("Something worth highlighting."),
  }),
  // A section of the service-page column: no top padding, mb-16 below.
  defaultStyle: {
    padding: { desktop: { top: 0, bottom: 64 } },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    // RichText's own wrapper and headings set colour and size.
    body: ["align", "hide"],
  },
  // The whole block is one card.
  onCard: ["eyebrow", "heading", "body"],
  ai: "A highlighted box of rich text with an optional eyebrow and heading: an offer summary, a key takeaway, a note in a blog post. Keep it short (1-3 paragraphs); use richText for long prose.",
});
