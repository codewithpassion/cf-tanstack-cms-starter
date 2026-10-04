import { z } from "zod";
import { buttonSchema } from "../links";
import { richTextFromString, richTextSchema } from "../richtext/schema";
import { defineBlock, itemKeySchema, keyedArray } from "./define";
import { ICON_NAMES } from "./icon-names";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(200),
  headingAccent: z.string().max(200).optional(),
  intro: z.string().max(600).optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  variant: z.enum(["cards", "plain", "services", "checklist"]),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      icon: z.enum(ICON_NAMES).optional(),
      title: z.string().min(1).max(200),
      body: richTextSchema.optional(),
      /** `services`: the whole card links here, with the label at the bottom ("Learn More →"). */
      link: buttonSchema.optional(),
    })
  )
    .min(1)
    .max(24),
});

type Props = z.output<typeof schema>;

export const featureGrid = defineBlock({
  type: "featureGrid",
  version: 1,
  label: "Feature grid",
  icon: "layout-grid",
  category: "content",
  schema,
  defaults: (): Props => ({
    eyebrow: "What's included",
    heading: "Section heading",
    columns: 3,
    variant: "cards",
    items: [1, 2, 3].map((n) => ({
      _key: `item${n}`,
      title: `Feature ${n}`,
      body: richTextFromString("Describe this feature in a sentence or two."),
    })),
  }),
  defaultStyle: {
    padding: {
      desktop: { top: 80, bottom: 80 },
      mobile: { top: 64, bottom: 64 },
    },
    gap: { desktop: 24 },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    headingAccent: ["color"],
    intro: ["color", "size", "align", "hide"],
    // Title and body set their own colour and size; align moves the text, not the (block-level) icon.
    items: ["align", "hide"],
  },
  // `cards`, `services` and `checklist` put each item on a card.
  onCard: ["items"],
  ai: 'A titled grid of 2-24 items (features, benefits, services). `cards` shows each item on a card; `plain` has no card; `services` is the home page\'s link cards (big icon, title, short body, the whole card links to `link.href` with `link.label` at the bottom, e.g. "Learn More →"; centre the block and use padding 128/96); `checklist` is a ✓ line per item on a small card (the title is the line; body optional; 2 columns, gap 16). Pick `columns` to suit the count (3 for 3/6/9 items, 2 or 4 for even counts). Item bodies are short rich text; icons come from a fixed list. `headingAccent` colours those words of the heading.',
});
