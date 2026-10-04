import { z } from "zod";
import { defineBlock, itemKeySchema, keyedArray } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().max(200).optional(),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      /** As displayed: "20+", "3-10x", "100%". */
      value: z.string().min(1).max(20),
      label: z.string().min(1).max(120),
    })
  )
    .min(1)
    .max(8),
});

type Props = z.output<typeof schema>;

export const stats = defineBlock({
  type: "stats",
  version: 1,
  label: "Stats",
  icon: "chart-column",
  category: "content",
  schema,
  defaults: (): Props => ({
    items: [
      { _key: "s1", value: "20+", label: "Years of experience" },
      { _key: "s2", value: "100%", label: "Focus on outcomes" },
      { _key: "s3", value: "3-10x", label: "Typical productivity gain" },
    ],
  }),
  defaultStyle: {
    padding: {
      desktop: { top: 80, bottom: 80 },
      mobile: { top: 64, bottom: 64 },
    },
    align: { desktop: "center" },
    gap: { desktop: 32 },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    // Value and label set their own colour and size.
    items: ["align", "hide"],
  },
  ai: '1-8 key numbers with short labels ("20+" / "Years building production systems"). Values are display text; only use figures the site already states.',
});
