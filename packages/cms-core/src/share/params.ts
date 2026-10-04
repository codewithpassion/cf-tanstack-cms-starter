// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; not on a hot path.
// biome-ignore-all lint/style/noNonNullAssertion: a failed Zod parse always has at least one issue.
import { z } from "zod";

import { mediaIdSchema } from "../media-schema";
import { isValidSlug } from "../paths";

/**
 * Share-image templates and their text overrides The overrides travel as
 * query parameters of `/og-render/<slug>`, so they are validated on the server before rendering.
 * Every field is optional: without overrides a template takes its text from the page document.
 */

export const SHARE_TEMPLATES = ["hero", "card", "post"] as const;
export type ShareTemplate = (typeof SHARE_TEMPLATES)[number];

/** Brand gradients for the card background when no image is chosen (see style/vars.ts). */
export const SHARE_GRADIENTS = [
  "primary-glow",
  "accent-glow",
  "accent-primary",
] as const;
export type ShareGradient = (typeof SHARE_GRADIENTS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

export const shareOverridesSchema = z.strictObject({
  eyebrow: text(60).optional(),
  headline: text(140).optional(),
  /** `post` only. */
  category: text(40).optional(),
  /** `post` only. */
  author: text(80).optional(),
  /** `card`: a media-library image behind the text. */
  bg: mediaIdSchema.optional(),
  /** `card`: the gradient when there is no image. */
  gradient: z.enum(SHARE_GRADIENTS).optional(),
});
export type ShareOverrides = z.output<typeof shareOverridesSchema>;

export const shareParamsSchema = shareOverridesSchema.extend({
  template: z.enum(SHARE_TEMPLATES).default("hero"),
});
export type ShareParams = z.output<typeof shareParamsSchema>;

function tryJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parses a query string the way TanStack Router's `defaultParseSearch` does: each value is
 * JSON-parsed when it can be ("2026" becomes a number), else kept as a string. The web route's
 * `validateSearch` and the request gate both use it, so they agree with `shareRenderQuery`.
 */
export function parseShareQuery(query: string): Record<string, unknown> {
  const search: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(query.replace(/^\?/, ""))) {
    const parsed = tryJson(value);
    search[key] = parsed.ok ? parsed.value : value;
  }
  return search;
}

/**
 * Parses `/og-render` query parameters (without `t`) as parsed by `parseShareQuery`. URLs built by shareRenderQuery keep every value
 * a string; a hand-built URL may still carry "2026" or true as a number or boolean, so primitives
 * are stringified back first.
 */
export function parseShareParams(
  search: Record<string, unknown>
): { ok: true; params: ShareParams } | { ok: false; error: string } {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (key === "t" || value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return { ok: false, error: `${key}: expected a string` };
    }
    raw[key] = String(value);
  }
  const parsed = shareParamsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return {
      ok: false,
      error: `${issue.path.join(".") || "params"}: ${issue.message}`,
    };
  }
  return { ok: true, params: parsed.data };
}

/**
 * The query string (without "?") for `/og-render/<slug>`: the token first, then the non-empty
 * params. A value that is valid JSON ("1.50", "null", a quoted headline) is itself quoted, as the
 * router's serialiser does, so the request gate and the route loader (both reading it with
 * `parseShareQuery`) get back exactly these strings.
 */
export function shareRenderQuery(token: string, params: ShareParams): string {
  const search = new URLSearchParams();
  const put = (key: string, value: string) =>
    search.set(key, tryJson(value).ok ? JSON.stringify(value) : value);
  put("t", token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      put(key, String(value));
    }
  }
  return search.toString();
}

const OG_PREFIX = "/og-render";

/** `/og-render/services/x` → "services/x"; `/og-render` → "" (home); anything else → null. */
export function ogSlugFromPath(pathname: string): string | null {
  if (pathname !== OG_PREFIX && !pathname.startsWith(`${OG_PREFIX}/`)) {
    return null;
  }
  const slug = pathname.slice(OG_PREFIX.length + 1);
  return isValidSlug(slug) ? slug : null;
}
