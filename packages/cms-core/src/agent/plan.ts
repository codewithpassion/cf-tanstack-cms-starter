// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/useIterableCallbackReturn: forEach callbacks written as expressions, as in the source.
import { isValidSlug } from "../paths";
import { isPostSlug } from "../posts";
import { isReservedSlug } from "../reserved";
import type { PageKind } from "../types";

/**
 * Site-wide plans: the agent proposes one
 * item per page, the user edits the checklist and approves it. The same checks run on the agent's
 * plan and on the user's edited one: slug format, built-in (reserved) slugs, taken slugs, pages
 * that must exist, duplicates. Pure and Zod-free.
 */

/** `edit`: change an existing page. `seo`: SEO work on an existing page. `create`: a new draft. `duplicate`: a draft copy of `from`. */
export const PLAN_ACTIONS = ["edit", "seo", "create", "duplicate"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export type PlanItemInput = {
  slug: string;
  action: PlanAction;
  /** What to do on this page, in a sentence or two. */
  intent: string;
  /** `duplicate`: the page to copy. */
  from?: string;
};

export const MAX_PLAN_ITEMS = 10;
export const MAX_INTENT = 1000;

/** What validation needs to know about the site's pages. */
export type PlanPage = {
  slug: string;
  kind: PageKind;
  status: "draft" | "published" | "archived";
};

export type PlanError = {
  path: string;
  code:
    | "INVALID_INPUT"
    | "INVALID_SLUG"
    | "SLUG_TAKEN"
    | "SLUG_RESERVED"
    | "NOT_FOUND";
  message: string;
};

/** "/about/" → "about": the agent and the user sometimes write paths. */
export const normalizeSlug = (slug: string) =>
  slug.trim().replace(/^\/+|\/+$/g, "");

/** The kind a new page at `slug` gets: posts live at `blog/<one segment>`. */
export const kindForSlug = (slug: string): PageKind =>
  isPostSlug(slug) ? "post" : "page";

export function validatePlan(
  raw: readonly PlanItemInput[],
  pages: readonly PlanPage[]
): { ok: true; items: PlanItemInput[] } | { ok: false; errors: PlanError[] } {
  const errors: PlanError[] = [];
  if (!raw.length) {
    errors.push({
      path: "items",
      code: "INVALID_INPUT",
      message: "A plan needs at least one page.",
    });
  }
  if (raw.length > MAX_PLAN_ITEMS) {
    errors.push({
      path: "items",
      code: "INVALID_INPUT",
      message: `At most ${MAX_PLAN_ITEMS} pages per run; split the work into several runs.`,
    });
  }
  const live = new Map(
    pages.filter((p) => p.status !== "archived").map((p) => [p.slug, p])
  );
  const seen = new Set<string>();
  const items: PlanItemInput[] = [];
  raw.forEach((item, i) => {
    const at = `items[${i}]`;
    const fail = (code: PlanError["code"], message: string, field = "slug") =>
      errors.push({ path: `${at}.${field}`, code, message });
    const slug = normalizeSlug(item.slug);
    const intent = item.intent.trim();
    const from = item.from === undefined ? undefined : normalizeSlug(item.from);
    if (!PLAN_ACTIONS.includes(item.action)) {
      return fail("INVALID_INPUT", `Unknown action "${item.action}"`, "action");
    }
    if (!intent) {
      fail("INVALID_INPUT", "Say what to do on this page", "intent");
    } else if (intent.length > MAX_INTENT) {
      fail(
        "INVALID_INPUT",
        `Keep the intent under ${MAX_INTENT} characters`,
        "intent"
      );
    }
    if (!isValidSlug(slug)) {
      return fail(
        "INVALID_SLUG",
        `"${item.slug}" isn't a valid slug: lowercase words separated by - and /`
      );
    }
    if (seen.has(slug)) {
      return fail(
        "INVALID_INPUT",
        `/${slug} is in the plan twice; one item per page`
      );
    }
    seen.add(slug);
    const out: PlanItemInput = { slug, action: item.action, intent };
    if (item.action === "edit" || item.action === "seo") {
      if (!live.has(slug)) {
        fail(
          "NOT_FOUND",
          `There is no CMS page at /${slug} (pages built into the site can't be edited by the agent)`
        );
      }
    } else {
      if (!slug) {
        return fail("SLUG_RESERVED", "The home page already exists");
      }
      let kind = kindForSlug(slug);
      if (item.action === "duplicate") {
        const source = from === undefined ? undefined : live.get(from);
        if (source) {
          out.from = from;
          if (source.kind !== kind) {
            fail(
              "INVALID_SLUG",
              source.kind === "post"
                ? "A copy of a post needs a slug like blog/<name>"
                : "A copy of a page can't live under blog/ (that's for posts)"
            );
            return;
          }
          kind = source.kind;
        } else {
          fail(
            "NOT_FOUND",
            from === undefined
              ? "A duplicate needs the page to copy (from)"
              : `There is no CMS page at /${from} to copy`,
            "from"
          );
        }
      }
      if (slug.startsWith("blog/") && kind === "page") {
        return fail(
          "INVALID_SLUG",
          "Slugs under blog/ are for posts: blog/<one-segment>"
        );
      }
      if (kind === "page" && isReservedSlug(slug)) {
        return fail(
          "SLUG_RESERVED",
          `/${slug} belongs to a page built into the site; pick another slug`
        );
      }
      if (live.has(slug)) {
        return fail("SLUG_TAKEN", `/${slug} is already a page`);
      }
    }
    items.push(out);
  });
  return errors.length ? { ok: false, errors } : { ok: true, items };
}
