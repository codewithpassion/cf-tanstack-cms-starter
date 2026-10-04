import { z } from "zod";
import { richTextToPlainText } from "../richtext/plain-text";
import { richTextFromString, richTextSchema } from "../richtext/schema";
import { defineBlock, itemKeySchema, keyedArray } from "./define";

const schema = z.strictObject({
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(200),
  items: keyedArray(
    z.strictObject({
      _key: itemKeySchema,
      q: z.string().min(1).max(300).describe("Question"),
      a: richTextSchema.describe("Answer"),
    })
  )
    .min(1)
    .max(50),
});

export const faq = defineBlock({
  type: "faq",
  version: 1,
  label: "FAQ",
  icon: "circle-help",
  category: "content",
  schema,
  defaults: () => ({
    heading: "Frequently asked",
    items: [
      {
        _key: "q1",
        q: "A common question?",
        a: richTextFromString("A short, direct answer."),
      },
    ],
  }),
  defaultStyle: {
    padding: {
      desktop: { top: 80, bottom: 80 },
      mobile: { top: 64, bottom: 64 },
    },
    maxWidth: { desktop: "narrow" },
    gap: { desktop: 16 },
  },
  elements: {
    eyebrow: ["color", "size", "align", "hide"],
    heading: ["color", "size", "align", "hide"],
    // Question and answer set their own colour and size.
    items: ["align", "hide"],
  },
  jsonLdElement: "items",
  ai: "Questions and answers, emitted as FAQPage JSON-LD. Write questions the way a customer would ask them; answer in 1-3 sentences first, then detail.",
  jsonLd: (props) => ({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: props.items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: richTextToPlainText(item.a) },
    })),
  }),
});
