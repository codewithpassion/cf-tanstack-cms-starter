import { z } from "zod";
import { hrefSchema } from "../links";
import { mediaIdSchema } from "../media-schema";
import { defineBlock, itemKeySchema, keyedArray } from "./define";
import { ICON_NAMES } from "./icon-names";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(200),
  headingAccent: z.string().max(200).optional(),
  subheading: z.string().max(300).optional(),
  subheadingAccent: z.string().max(300).optional(),
  /** A highlighted box under the heading: an emphasised first line, then a quieter one. */
  callout: z
    .strictObject({
      lead: z.string().min(1).max(300),
      body: z.string().max(300).optional(),
    })
    .optional(),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      name: z.string().min(1).max(120),
      caption: z.string().max(300).optional(),
      /** A logo from the media library; without one, the item shows its icon (a text badge). */
      image: mediaIdSchema.optional(),
      icon: z.enum(ICON_NAMES).optional(),
    })
  ).max(12),
  /** A closing statement; a new line in the text is a line break. */
  quote: z.string().max(600).optional(),
  quoteAccent: z.string().max(300).optional(),
  button: z
    .strictObject({
      label: z.string().min(1).max(80),
      /** Shown instead of `label` below 640px wide. */
      shortLabel: z.string().max(60).optional(),
      href: hrefSchema,
    })
    .optional(),
});

type Props = z.output<typeof schema>;

export const logos = defineBlock({
  type: "logos",
  version: 1,
  label: "Trust / logos",
  icon: "badge-check",
  category: "content",
  schema,
  defaults: (): Props => ({
    eyebrow: "Why it matters",
    heading: "A bold claim backed by proof",
    subheading: "One line on what you do about it.",
    items: [1, 2, 3].map((n) => ({
      _key: `item${n}`,
      name: `Proof point ${n}`,
      caption: "A short line of evidence.",
      icon: "check" as const,
    })),
  }),
  // py-24 md:py-32 over bg-ink-soft/30 with an accent wash from the left.
  defaultStyle: {
    padding: {
      desktop: { top: 128, bottom: 128 },
      mobile: { top: 96, bottom: 96 },
    },
    align: { desktop: "center" },
    gap: { desktop: 32 },
    background: { gradient: "accent-edge" },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    headingAccent: ["color"],
    subheading: ["color", "size", "align", "hide"],
    subheadingAccent: ["color"],
    // The callout's two lines set their own colours.
    callout: ["size", "align", "hide"],
    // Name and caption set their own colour and size.
    items: ["align", "hide"],
    quote: ["color", "size", "align", "hide"],
    quoteAccent: ["color"],
    // The link sets its own colours; its font size is inherited.
    button: ["size", "align", "hide"],
  },
  // The callout box and the proof items are translucent cards.
  onCard: ["callout", "items"],
  ai: "A trust section: a bold claim (heading, with `headingAccent` words coloured), an optional subheading and highlighted callout (an emphasised line plus a quieter one), up to 12 proof items, then an optional quote and button. Items are text badges (icon, name, caption) or client logos (image from the media library, name as alt text). Accents must appear verbatim in their text. `button.shortLabel` replaces the label on small phones.",
});
