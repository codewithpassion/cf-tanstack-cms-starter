// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source (kept diffable).
// biome-ignore-all lint/style/noNestedTernary: the issue path formatter is ported verbatim from the source (kept diffable).
import { z } from "zod";

import { hrefSchema } from "../links";
import { mediaIdSchema } from "../media-schema";
import { HEX_RE } from "../style/schema";
import type { SiteDoc } from "./types";

/**
 * Zod schema for the site doc (types.ts). Server and admin only: the public site reads a doc
 * validated here (read-site.ts) and never bundles Zod. Every write and every KV read goes through
 * `validateSiteDoc`.
 */

export const SITE_LIMITS = {
  navLinks: 12,
  navChildren: 12,
  footerColumns: 6,
  columnLinks: 20,
  highlights: 6,
  legalLinks: 6,
  swatches: 24,
  sameAs: 10,
} as const;

const keySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Expected a key of letters, digits, - and _");
const label = (max = 60) =>
  z.string().trim().min(1, "Required").max(max, `At most ${max} characters`);
const httpsUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Expected an https:// URL");

/**
 * A nav or footer link. `$`, `{` and `}` are refused on top of the block link rules: the router
 * reads them in a path as route params, so such a link wouldn't go where it says (use-site.tsx
 * `SiteHref` renders any that are already published as plain anchors).
 */
const siteHrefSchema = hrefSchema.refine(
  (v) => !/[${}]/.test(v),
  "Links can't contain $, { or }"
);

const linkSchema = z.strictObject({
  _key: keySchema,
  label: label(),
  href: siteHrefSchema,
});

/** Each `_key` once per list (the editor's drag and drop and React keys rely on it). */
function uniqueKeys<T extends z.ZodType<{ _key: string }>>(
  item: T,
  max: number,
  what: string
) {
  return z
    .array(item)
    .max(max, `At most ${max} ${what}`)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (seen.has(it._key)) {
          ctx.addIssue({
            code: "custom",
            path: [i, "_key"],
            message: "Duplicate key",
          });
        }
        seen.add(it._key);
      });
    });
}

const navItemSchema = linkSchema.extend({
  children: uniqueKeys(
    linkSchema,
    SITE_LIMITS.navChildren,
    "dropdown links"
  ).optional(),
});

export const siteDocSchema = z.strictObject({
  _schema: z.literal(1),
  nav: z.strictObject({
    links: uniqueKeys(navItemSchema, SITE_LIMITS.navLinks, "nav links"),
    cta: z.strictObject({ label: label(), href: siteHrefSchema }),
  }),
  footer: z.strictObject({
    tagline: label(120),
    location: label(120),
    columns: uniqueKeys(
      z.strictObject({
        _key: keySchema,
        title: label(),
        links: uniqueKeys(
          linkSchema,
          SITE_LIMITS.columnLinks,
          "links in a column"
        ),
      }),
      SITE_LIMITS.footerColumns,
      "footer columns"
    ),
    highlights: z.strictObject({
      title: label(),
      items: uniqueKeys(
        z.strictObject({ _key: keySchema, text: label(200) }),
        SITE_LIMITS.highlights,
        "highlights"
      ),
    }),
    copyright: label(200),
    legalLinks: uniqueKeys(linkSchema, SITE_LIMITS.legalLinks, "legal links"),
  }),
  seo: z.strictObject({
    titleTemplate: z
      .string()
      .trim()
      .max(120)
      .refine(
        (v) => v.split("%s").length === 2,
        "Use %s exactly once, where the page title goes"
      ),
    defaultShareImage: z.strictObject({
      mediaId: mediaIdSchema.optional(),
      url: hrefSchema.refine(
        (v) => v.startsWith("/") || v.startsWith("https:"),
        "Expected /path or an https:// URL"
      ),
      alt: z.string().max(300),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
    organization: z.strictObject({
      name: label(120),
      url: httpsUrl,
      logo: httpsUrl,
      sameAs: z.array(httpsUrl).max(SITE_LIMITS.sameAs),
    }),
    twitterCard: z.enum(["summary", "summary_large_image"]),
  }),
  swatches: uniqueKeys(
    z.strictObject({
      _key: keySchema,
      hex: z.string().regex(HEX_RE, "Expected a hex colour like #ff6633"),
      name: z.string().trim().max(40).optional(),
    }),
    SITE_LIMITS.swatches,
    "swatches"
  ),
});

export type SiteValidation =
  | { ok: true; doc: SiteDoc }
  | { ok: false; errors: { path: string; message: string }[] };

export function validateSiteDoc(doc: unknown): SiteValidation {
  const res = siteDocSchema.safeParse(doc);
  if (res.success) {
    return { ok: true, doc: res.data as SiteDoc };
  }
  return {
    ok: false,
    errors: res.error.issues.map((issue) => ({
      path: issue.path.reduce<string>(
        (p, k) =>
          typeof k === "number"
            ? `${p}[${k}]`
            : p
              ? `${p}.${String(k)}`
              : String(k),
        ""
      ),
      message: issue.message,
    })),
  };
}
