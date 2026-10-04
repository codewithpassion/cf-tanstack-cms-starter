import { z } from "zod";
import { richTextFromString, richTextSchema } from "../richtext/schema";
import { defineBlock, itemKeySchema, keyedArray } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().max(200).optional(),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      body: richTextSchema.describe("Text"),
    })
  )
    .min(1)
    .max(20),
  note: richTextSchema
    .optional()
    .describe("Note (highlighted box under the list)"),
});

type Props = z.output<typeof schema>;

export const checklist = defineBlock({
  type: "checklist",
  version: 1,
  label: "Checklist",
  icon: "list-todo",
  category: "content",
  schema,
  defaults: (): Props => ({
    eyebrow: "Checklist",
    heading: "What to have ready.",
    items: [{ _key: "c1", body: richTextFromString("Something to prepare.") }],
    note: richTextFromString("Need help? Get in touch."),
  }),
  defaultStyle: {
    padding: {
      desktop: { top: 80, bottom: 80 },
      mobile: { top: 64, bottom: 64 },
    },
    maxWidth: { desktop: "narrow" },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    // Item text is rich text: its own wrapper sets colour and size.
    items: ["align", "hide"],
    note: ["align", "hide"],
  },
  ai: "A checklist (empty boxes) of things to do or have ready beforehand: requirements, preparation steps. One item per thing, a sentence or two, with links and inline code where useful. `note` is an optional highlighted box underneath, e.g. for help if someone gets stuck.",
});
