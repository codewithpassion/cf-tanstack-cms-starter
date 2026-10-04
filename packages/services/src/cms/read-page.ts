import { isValidSlug, resolvePath, slugToPath } from "@repo/cms-core/paths";
import { isStaticPage } from "@repo/cms-core/reserved";

import { readPagesIndex } from "./pages-index";
import { logTokenError, type RenderClaims } from "./render-token";

/**
 * `page` is the raw KV value, a `LivePage` as JSON (see `cmsPageData`). Passing the text through
 * skips a parse and re-serialise, and TanStack's serialisable-type check rejects `unknown` (block
 * props), so a typed `LivePage` can't be returned from a server function. `parents` are the
 * page's ancestors that are live CMS pages (for breadcrumbs). `preview`: `page` is the page's DRAFT,
 * shown through a valid preview token (`readPreviewPage`), not the published page. `posts`: the
 * raw KV `posts:index`, for a page with a `postList` block (`withPosts`).
 */
export type CmsPageResult =
  | { page: string; parents: string[]; preview?: true; posts?: string }
  | { redirect: string }
  | { page: null };

/**
 * What `readPreviewPage` needs from the Worker: `verify` checks a "preview" render token for the
 * slug and returns its claims, or null (render-token.ts); `draft` reads the page at that slug from
 * D1, its id and draft; `changeset` reads a staged agent proposal (its page, status and proposed
 * page). Injected so the gating is unit-tested without crypto or D1.
 */
export type PreviewDeps = {
  kv: { get: (key: string) => Promise<string | null> };
  verify: (slug: string, token: string) => Promise<RenderClaims | null>;
  draft: (slug: string) => Promise<{ id: string; doc: unknown } | null>;
  changeset: (
    id: string
  ) => Promise<{ pageId: string; status: string; doc: unknown } | null>;
};

/**
 * A draft preview (docs/cms-plan.md §3.6): with a token valid for the slug at `path` AND minted for
 * the page that holds that slug now (`pageId`), that page's DRAFT, as the `page` text
 * `cmsPageData` reads (`{ doc }`). Null when the path isn't a page's own URL, the token isn't valid
 * for it, names another page (slugs move between pages), has no page id, there's no draft, or a
 * read fails: the caller then reads the live page as usual, so a bad token looks exactly like no
 * token.
 *
 * A token with a `changesetId` (an agent's `get_preview_url`) shows that proposal's page instead,
 * only while the proposal is pending and belongs to the token's page. Otherwise it is a miss
 * (`{ page: null }`), so the link never passes off the draft, the live page or another page as
 * the proposal.
 */
export async function readPreviewPage(
  deps: PreviewDeps,
  path: string,
  token: string
): Promise<CmsPageResult | null> {
  const resolved = resolvePath(path);
  if (!resolved || "redirect" in resolved) {
    return null;
  }
  try {
    const claims = await deps.verify(resolved.slug, token);
    if (!claims?.pageId) {
      return null;
    }
    const page = await deps.draft(resolved.slug);
    if (!page || page.id !== claims.pageId || !page.doc) {
      return null;
    }
    let { doc } = page;
    if (claims.changesetId !== undefined) {
      const cs = await deps.changeset(claims.changesetId);
      if (!cs || cs.pageId !== page.id || cs.status !== "pending" || !cs.doc) {
        return { page: null };
      }
      ({ doc } = cs);
    }
    return {
      page: JSON.stringify({ doc }),
      parents: await cmsParents(deps.kv, resolved.slug),
      preview: true,
    };
  } catch (err) {
    // No signing key (logged once), or D1 or KV unavailable: show what visitors see.
    logTokenError(`readPreviewPage: preview read failed for ${path}`, err);
    return null;
  }
}

/**
 * The public read path (docs/cms-plan.md §3.7): KV only, never D1. Looks up `page:<slug>`; on a
 * miss, `redirect:<slug>` (left behind by a slug change; a target that isn't a valid slug is a
 * miss, so a bad value can't send visitors off-site). A KV failure is logged and treated as a
 * miss, so the route shows its "nothing published" page.
 */
export async function readCmsPage(
  kv: { get: (key: string) => Promise<string | null> },
  path: string
): Promise<CmsPageResult> {
  const resolved = resolvePath(path);
  if (!resolved) {
    return { page: null };
  }
  if ("redirect" in resolved) {
    return resolved;
  }
  try {
    const live = await kv.get(`page:${resolved.slug}`);
    if (live !== null) {
      return { page: live, parents: await cmsParents(kv, resolved.slug) };
    }
    const target = await kv.get(`redirect:${resolved.slug}`);
    return target !== null && isValidSlug(target)
      ? { redirect: slugToPath(target) }
      : { page: null };
  } catch (err) {
    console.error(`loadCmsPage: KV read failed for ${path}`, err);
    return { page: null };
  }
}

/**
 * The page's ancestors (`guides` and `guides/a` for `guides/a/b`) that are live CMS pages, for its
 * breadcrumbs. Static pages are known without a lookup, so `pages:index` is read only when some
 * ancestor isn't one.
 */
async function cmsParents(
  kv: { get: (key: string) => Promise<string | null> },
  slug: string
): Promise<string[]> {
  const segments = slug.split("/");
  const ancestors = segments
    .slice(1)
    .map((_, i) => segments.slice(0, i + 1).join("/"));
  if (ancestors.every(isStaticPage)) {
    return [];
  }
  const live = new Set((await readPagesIndex(kv)).map((p) => p.slug));
  return ancestors.filter((a) => !isStaticPage(a) && live.has(a));
}

/**
 * Adds the raw KV `posts:index` to a page that has a `postList` block (docs/cms-plan.md §3.8), so
 * the block renders on the server; other pages skip the read. A KV failure leaves the list empty.
 */
export async function withPosts(
  kv: { get: (key: string) => Promise<string | null> },
  result: CmsPageResult
): Promise<CmsPageResult> {
  if (
    !(
      "page" in result &&
      result.page &&
      result.page.includes('"_type":"postList"')
    )
  ) {
    return result;
  }
  try {
    const posts = await kv.get("posts:index");
    return posts === null ? result : { ...result, posts };
  } catch (err) {
    console.error("loadCmsPage: could not read posts:index", err);
    return result;
  }
}
