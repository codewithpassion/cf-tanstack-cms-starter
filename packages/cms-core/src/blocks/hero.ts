import { z } from "zod";
import { buttonSchema } from "../links";
import { mediaIdSchema } from "../media-schema";
import { defineBlock } from "./define";

const schema = z.strictObject({
  variant: z.enum(["page", "minimal", "home"]),
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(200),
  /** Words of `heading` shown in the accent colour (element `headingAccent`). */
  headingAccent: z.string().max(200).optional(),
  lead: z.string().max(600).optional(),
  primary: buttonSchema.optional(),
  secondary: buttonSchema.optional(),
  /** `home` only: a third button. */
  tertiary: buttonSchema.optional().describe("Tertiary (Home variant only)"),
  /**
   * `home` only: the brand logo beside the text, from the media library. (The source site used a
   * built-in SVG; this site ships no logo asset, so it is an optional media image with no default.)
   */
  logo: z
    .strictObject({ mediaId: mediaIdSchema, alt: z.string().max(300) })
    .optional()
    .describe("Logo (Home variant only)"),
});

type Props = z.output<typeof schema>;

export const hero = defineBlock({
  type: "hero",
  version: 1,
  label: "Hero",
  icon: "panel-top",
  category: "layout",
  schema,
  defaults: (): Props => ({
    variant: "page",
    eyebrow: "Label",
    heading: "Page heading",
    lead: "One or two sentences that set up the page.",
  }),
  defaultStyle: {
    padding: { desktop: { top: 128, bottom: 80 } },
    align: { desktop: "center" },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    headingAccent: ["color"],
    lead: ["color", "size", "align", "hide"],
    // The links set their own colours; their font size is inherited.
    buttons: ["size", "align", "hide"],
    logo: ["hide"],
  },
  ai: "The page's opening section with the only H1. Use once, first on the page. `page` is the standard large hero; `minimal` is a smaller title band; `home` is the home page's full-height hero (logo beside the text when `logo` is on, up to three large buttons, and the eyebrow shown as a [bracketed] tagline under the lead; give it padding top 120 / bottom 0 and left alignment). `headingAccent` colours those words of the heading (they must appear in it). Keep the heading under ~60 characters and the lead to 1-2 sentences. Buttons are optional.",
});
