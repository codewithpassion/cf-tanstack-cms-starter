import { z } from "zod";
import { type RichTextDoc, richTextSchema } from "../richtext/schema";
import { defineBlock, itemKeySchema, keyedArray } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(200),
  intro: z.string().max(600).optional(),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      /** A short marker before the title: "01", "Week 1". */
      label: z.string().max(40),
      title: z.string().min(1).max(150),
      body: richTextSchema,
    })
  )
    .min(1)
    .max(12),
});

type Props = z.output<typeof schema>;

const bullets = (...points: string[]): RichTextDoc => ({
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: points.map((text) => ({
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      })),
    },
  ],
});

export const steps = defineBlock({
  type: "steps",
  version: 1,
  label: "Steps",
  icon: "list-ordered",
  category: "content",
  schema,
  defaults: (): Props => ({
    eyebrow: "How it works",
    heading: "How it runs",
    items: [1, 2, 3].map((n) => ({
      _key: `step${n}`,
      label: `0${n}`,
      title: `Step ${n}`,
      body: bullets("What happens in this step.", "What you get from it."),
    })),
  }),
  // A section of the service-page column: no top padding, mb-16 below; space-y-6 between cards.
  defaultStyle: {
    padding: { desktop: { top: 0, bottom: 64 } },
    gap: { desktop: 24 },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    intro: ["color", "size", "align", "hide"],
    // Label, title and body set their own colour and size.
    items: ["align", "hide"],
  },
  // Each step is a card.
  onCard: ["items"],
  ai: 'An ordered process: 1-12 steps or phases, each with a short `label` ("01", "Week 1"), a title and a rich-text body. Bullet lists in a body render as ✓ rows, so prefer 2-4 short bullets per step. Emits no structured data.',
});
