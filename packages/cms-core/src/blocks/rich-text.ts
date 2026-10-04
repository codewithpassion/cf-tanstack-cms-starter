import { z } from "zod";
import { richTextFromString, richTextSchema } from "../richtext/schema";
import { defineBlock } from "./define";

const schema = z.strictObject({ body: richTextSchema });

export const richText = defineBlock({
  type: "richText",
  version: 1,
  label: "Rich text",
  icon: "type",
  category: "content",
  schema,
  defaults: () => ({ body: richTextFromString("Write something here.") }),
  defaultStyle: {
    padding: {
      desktop: { top: 64, bottom: 64 },
      mobile: { top: 48, bottom: 48 },
    },
    maxWidth: { desktop: "narrow" },
  },
  elements: {
    // RichText's own wrapper and headings set colour and size.
    body: ["align", "hide"],
  },
  ai: "Long-form prose: paragraphs, H2/H3 subheadings, bullet and numbered lists, blockquotes, bold/italic/code and links. Never use H1 here (the hero owns it). Use H2 for sections and H3 below it.",
});
