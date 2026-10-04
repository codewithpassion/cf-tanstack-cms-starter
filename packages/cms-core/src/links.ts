import { z } from "zod";

import { isSafeHref } from "./safe-href";

// biome-ignore lint/performance/noBarrelFile: links.ts is the link rule's public home (schemas and the check together).
export { isSafeHref } from "./safe-href";

export const hrefSchema = z
  .string()
  .max(2048)
  .refine(
    isSafeHref,
    "Links must be relative (/path, #id) or use https:, mailto: or tel:"
  );

export const buttonSchema = z.strictObject({
  label: z.string().min(1).max(60),
  href: hrefSchema,
});
export type Button = z.infer<typeof buttonSchema>;
