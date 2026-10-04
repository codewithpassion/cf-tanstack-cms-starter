import { z } from "zod";
import { mediaIdSchema } from "../media-schema";
import { defineBlock, itemKeySchema, keyedArray } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().max(200).optional(),
  headingAccent: z.string().max(200).optional(),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      quote: z.string().min(1).max(1000),
      name: z.string().min(1).max(100),
      role: z.string().max(150),
      company: z.string().max(150).optional(),
      image: mediaIdSchema.optional(),
    })
  )
    .min(1)
    .max(20),
  /** Seconds per testimonial when there are several; 0 = no autoplay. Never plays in the editor. */
  autoplay: z.number().int().min(0).max(60),
});

type Props = z.output<typeof schema>;

export const testimonial = defineBlock({
  type: "testimonial",
  version: 1,
  label: "Testimonial",
  icon: "quote",
  category: "content",
  schema,
  defaults: (): Props => ({
    eyebrow: "Client success",
    heading: "What clients say",
    items: [
      {
        _key: "t1",
        quote: "A short, specific quote about the result you delivered.",
        name: "Client name",
        role: "Role",
        company: "Company",
      },
    ],
    autoplay: 0,
  }),
  // py-24 md:py-32 on deep black, max-w-4xl.
  defaultStyle: {
    padding: {
      desktop: { top: 128, bottom: 128 },
      mobile: { top: 96, bottom: 96 },
    },
    maxWidth: { desktop: "narrow" },
    align: { desktop: "center" },
    background: { color: { token: "ink" } },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    headingAccent: ["color"],
    // Quote, name and role set their own colour and size.
    card: ["align", "hide"],
  },
  // The quote card.
  onCard: ["card"],
  ai: 'One customer quote, or a carousel of several with dots. Quotes are verbatim from real clients: never invent or edit them. `role` and `company` render as "Role at Company". `autoplay` is seconds per slide (0 = manual); use 0 for a single quote.',
});
