import { z } from "zod";

import { mediaIdSchema } from "../media-schema";
import { type BlockStyle, BRAND_TOKENS } from "../types";

/** Hex colours land in inline styles, so only plain #rgb/#rgba/#rrggbb/#rrggbbaa are accepted. */
export const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const colorSchema = z.union([
  z.strictObject({ token: z.enum(BRAND_TOKENS) }),
  z.strictObject({
    hex: z.string().regex(HEX_RE, "Expected a hex colour like #ff7733"),
  }),
]);

export function responsive<T extends z.ZodType>(value: T) {
  return z.strictObject({
    desktop: value.optional(),
    tablet: value.optional(),
    mobile: value.optional(),
  });
}

export const visibilitySchema = z.strictObject({
  desktop: z.boolean().optional(),
  tablet: z.boolean().optional(),
  mobile: z.boolean().optional(),
});

const alignSchema = z.enum(["left", "center", "right"]);
const px = (min: number, max: number) => z.number().int().min(min).max(max);

export const elementStyleSchema = z.strictObject({
  color: colorSchema.optional(),
  size: responsive(z.enum(["sm", "base", "lg", "xl", "2xl"])).optional(),
  align: responsive(alignSchema).optional(),
  hide: visibilitySchema.optional(),
});

export const blockStyleSchema = z.strictObject({
  hide: visibilitySchema.optional(),
  padding: responsive(
    z.strictObject({
      top: px(0, 512).optional(),
      bottom: px(0, 512).optional(),
      x: px(0, 256).optional(),
    })
  ).optional(),
  margin: responsive(
    z.strictObject({
      top: px(-256, 512).optional(),
      bottom: px(-256, 512).optional(),
    })
  ).optional(),
  gap: responsive(px(0, 256)).optional(),
  maxWidth: responsive(
    z.enum(["narrow", "default", "wide", "full"])
  ).optional(),
  align: responsive(alignSchema).optional(),
  background: z
    .strictObject({
      color: colorSchema.optional(),
      gradient: z
        .enum([
          "none",
          "dark",
          "ink-rise",
          "primary-glow",
          "accent-glow",
          "accent-edge",
          "accent-primary",
        ])
        .optional(),
      image: z
        .strictObject({
          mediaId: mediaIdSchema,
          overlay: colorSchema.optional(),
          opacity: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
  colors: z
    .strictObject({
      text: colorSchema.optional(),
      heading: colorSchema.optional(),
      accent: colorSchema.optional(),
    })
    .optional(),
  border: z.enum(["none", "glow", "subtle"]).optional(),
  elements: z.record(z.string(), elementStyleSchema).optional(),
});

// Keep the schema and the shared type in lock-step.
// biome-ignore lint/suspicious/noUnusedExpressions: a type-level assertion.
blockStyleSchema satisfies z.ZodType<BlockStyle>;
