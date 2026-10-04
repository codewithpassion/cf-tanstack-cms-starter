import { z } from "zod";
import { buttonSchema } from "../links";
import { defineBlock, itemKeySchema, keyedArray } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(200),
  intro: z.string().max(600).optional(),
  plans: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      /** Optional with a single plan (the section heading names it). */
      name: z.string().max(80).optional(),
      /** As displayed, e.g. "$18,900 + GST". */
      price: z.string().min(1).max(60),
      /** After the price, e.g. "per 40-hour block". */
      unit: z.string().max(80).optional(),
      /** Emphasise this plan (accent border). */
      highlight: z.boolean().optional(),
      inclusions: keyedArray(
        z.strictObject({
          _key: itemKeySchema,
          text: z.string().min(1).max(200),
        })
      ).max(20),
      cta: buttonSchema.optional(),
    })
  )
    .min(1)
    .max(4),
  /** Terms under the price(s): what a block includes, how billing works. */
  note: z.string().max(1000).optional(),
});

type Props = z.output<typeof schema>;

export const pricing = defineBlock({
  type: "pricing",
  version: 1,
  label: "Pricing",
  icon: "badge-dollar-sign",
  category: "conversion",
  schema,
  defaults: (): Props => ({
    eyebrow: "Investment",
    heading: "Pricing",
    plans: [
      {
        _key: "plan1",
        price: "$0,000 + GST",
        unit: "per engagement",
        inclusions: [],
      },
    ],
    note: "What the price covers, and how billing works.",
  }),
  // A section of the service-page column: no top padding, mb-16 below.
  defaultStyle: {
    padding: { desktop: { top: 0, bottom: 64 } },
    gap: { desktop: 24 },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    intro: ["color", "size", "align", "hide"],
    // The unit sets its own colour and size; size and colour apply to the price itself.
    price: ["color", "size", "align", "hide"],
    // Name and inclusions set their own colour and size.
    plans: ["align", "hide"],
    // The link sets its own colours; its font size is inherited.
    cta: ["size", "align", "hide"],
    note: ["color", "size", "align", "hide"],
  },
  // One plan: the whole section is a card; several: each plan is.
  onCard: ["eyebrow", "heading", "intro", "price", "plans", "cta", "note"],
  ai: 'Prices as shown to visitors, 1-4 plans. With one plan the whole section is a single card (heading, price + unit, optional inclusions and button, then the note); with several, each plan is a card and `highlight` marks the recommended one. Write prices exactly as they should read ("$18,900 + GST"). Never emits Offer JSON-LD; page-level offers go in the SEO schema extras.',
});
