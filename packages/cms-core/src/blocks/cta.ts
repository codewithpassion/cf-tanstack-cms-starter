import { z } from "zod";
import { buttonSchema } from "../links";
import { defineBlock } from "./define";

const schema = z
  .strictObject({
    /** Unset = `default`. */
    variant: z.enum(["default", "large", "compact"]).optional(),
    /** Required except in `compact`. */
    heading: z.string().min(1).max(200).optional(),
    headingAccent: z.string().max(200).optional(),
    body: z.string().max(600).optional(),
    primary: buttonSchema,
    secondary: buttonSchema.optional(),
    /** A text link under the buttons, e.g. "← All Services". */
    link: buttonSchema.optional(),
  })
  .superRefine((p, ctx) => {
    // An empty string already fails `min(1)`: report a missing heading only, so it shows once.
    if (p.variant !== "compact" && p.heading === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["heading"],
        message: "A heading is required (except in the compact variant)",
      });
    }
  });

type Props = z.output<typeof schema>;

export const cta = defineBlock({
  type: "cta",
  version: 1,
  label: "Call to action",
  icon: "mouse-pointer-click",
  category: "conversion",
  schema,
  defaults: (): Props => ({
    variant: "default",
    heading: "Ready to get started?",
    body: "Book a free consultation to explore how AI can amplify your business.",
    primary: { label: "Schedule your call", href: "/contact" },
  }),
  defaultStyle: {
    padding: {
      desktop: { top: 128, bottom: 128 },
      mobile: { top: 96, bottom: 96 },
    },
    maxWidth: { desktop: "narrow" },
    align: { desktop: "center" },
    background: { gradient: "dark" },
  },
  elements: {
    heading: ["color", "size", "align", "hide"],
    headingAccent: ["color"],
    body: ["color", "size", "align", "hide"],
    // The links set their own colours; their font size is inherited (fixed in `large`).
    buttons: ["size", "align", "hide"],
    // The link sets its own colour and size.
    link: ["align", "hide"],
  },
  ai: 'A closing call to action: a short heading, one supporting sentence and a primary button (secondary optional). Usually the last block on a page; at most one per page. `default` has uppercase buttons; `large` is the home page\'s bigger, mixed-case button; `compact` is a quiet ending with no heading: one muted sentence, the button and an optional text `link` (e.g. "← All Services"). `headingAccent` colours those words of the heading.',
});
