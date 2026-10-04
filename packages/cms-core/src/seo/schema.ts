import { z } from "zod";

import { mediaIdSchema } from "../media-schema";
import { SLUG_MAX, SLUG_RE } from "../paths";
import type { PageSeo, PostMeta } from "../types";

/** Path-like slug without leading/trailing slash, e.g. `services/automation-sprint`; "" is the home page. */
export const slugSchema = z
  .string()
  .max(SLUG_MAX)
  .regex(SLUG_RE, "Use lowercase words separated by - and /");

/** Whether `decodeURI` can read the URL (a lone "%E0" can't be decoded, and would break the previews). */
export function isDecodable(url: string): boolean {
  try {
    decodeURI(url);
    return true;
  } catch {
    return false;
  }
}

const imageRefSchema = z.strictObject({
  mediaId: mediaIdSchema,
  alt: z.string().max(300),
});

/** The share image also keeps the media's size (for og:image:width/height), when known. */
const shareImageSchema = imageRefSchema.extend({
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});

/**
 * Keys the page's own JSON-LD node derives from the page (render/page-json-ld.ts). A `schema.extra`
 * node that extends the page node can't change them unless it lists them in `_override`.
 */
export const DERIVED_JSON_LD_KEYS = [
  "name",
  "headline",
  "description",
  "url",
  "@id",
  "breadcrumb",
] as const;

/**
 * A schema.org node for what blocks can't derive (§3.9 `schema.extra`). `_override` (never emitted)
 * lists the page-derived keys this node replaces when it extends the page node.
 */
const jsonLdNodeSchema = z
  .record(z.string(), z.unknown())
  .refine((node) => "@type" in node, "JSON-LD nodes need an @type")
  .refine(
    (node) =>
      node._override === undefined ||
      z
        .array(z.enum(DERIVED_JSON_LD_KEYS))
        .max(DERIVED_JSON_LD_KEYS.length)
        .safeParse(node._override).success,
    {
      message: `_override lists keys from: ${DERIVED_JSON_LD_KEYS.join(", ")}`,
      path: ["_override"],
    }
  );

export const pageSeoSchema = z.strictObject({
  title: z.string().min(1).max(200),
  titleExact: z.boolean().optional(),
  description: z.string().max(1000),
  slug: slugSchema,
  canonical: z
    .url({ protocol: /^https$/ })
    .refine(isDecodable, "The URL has a malformed %-escape")
    .optional(),
  robots: z.strictObject({ index: z.boolean(), follow: z.boolean() }),
  sitemap: z.strictObject({ include: z.boolean() }),
  focusKeyphrase: z.string().max(100).optional(),
  social: z.strictObject({
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    image: shareImageSchema.optional(),
  }),
  schema: z.strictObject({
    pageType: z.enum([
      "WebPage",
      "Service",
      "LocalBusiness",
      "AboutPage",
      "ContactPage",
      "CollectionPage",
      "Article",
    ]),
    breadcrumbLabel: z.string().max(100).optional(),
    extra: z.array(jsonLdNodeSchema).max(20).optional(),
  }),
  llms: z.strictObject({
    include: z.boolean(),
    summary: z.string().max(2000).optional(),
  }),
});

const postDateSchema = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
]);

export const postMetaSchema = z
  .strictObject({
    title: z.string().min(1).max(200).optional(),
    excerpt: z.string().max(1000),
    author: z.string().min(1).max(100),
    publishedAt: postDateSchema,
    modifiedAt: postDateSchema.optional(),
    category: z.string().min(1).max(100),
    tags: z.array(z.string().min(1).max(50)).max(30),
    featuredImage: imageRefSchema.optional(),
    readingTime: z.number().int().min(0),
    readingTimeOverride: z.number().int().min(1).max(999).optional(),
    publishedAtAuto: z.literal(true).optional(),
  })
  // Compared as calendar days ("2026-07-12" against an ISO timestamp's first 10 characters).
  .refine(
    (p) =>
      p.modifiedAt === undefined ||
      p.modifiedAt.slice(0, 10) >= p.publishedAt.slice(0, 10),
    {
      message: "The updated date can't be before the published date",
      path: ["modifiedAt"],
    }
  );

// Keep the schemas and the shared types in lock-step (compile-time checks).
// biome-ignore lint/suspicious/noUnusedExpressions: a type-level assertion.
pageSeoSchema satisfies z.ZodType<PageSeo>;
// biome-ignore lint/suspicious/noUnusedExpressions: a type-level assertion.
postMetaSchema satisfies z.ZodType<PostMeta>;
