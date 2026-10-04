import { slugToPath } from "@repo/cms-core/paths";
import type { PostSummary } from "@repo/cms-core/posts";
import { buildHead } from "@repo/cms-core/seo/build-head";
import type { PageDoc } from "@repo/cms-core/types";
import type { LivePage } from "@repo/services/cms/pages-service";
import type { CmsPageResult } from "@repo/services/cms/read-page";
import { notFound, redirect } from "@tanstack/react-router";

import {
  siteConfigFromMatches,
  siteSeoFromMatches,
} from "../site/site-context";

/**
 * Loader-side helpers for `loadCmsPage` results. Route loaders run in every page's entry chunk,
 * so this module must stay free of Zod, the block registry and the renderer.
 */

/**
 * `parents`: the page's ancestor slugs that are live CMS pages (breadcrumbs link to them).
 * `preview`: this is the page's draft, shown through a preview link (load-page.ts), not the live page.
 */
export type CmsPageData = {
  doc: PageDoc;
  path: string;
  parents: string[];
  /** KV `posts:index`, newest first, when the page has a `postList` block (load-page.ts). */
  posts?: PostSummary[];
  preview?: true;
};

/** The published page in a `loadCmsPage` result, as loader data for `CmsPage`. A corrupt KV value is a miss. */
export function cmsPageData(result: CmsPageResult): CmsPageData | null {
  if (!("page" in result && result.page)) {
    return null;
  }
  try {
    const { doc } = JSON.parse(result.page) as Pick<LivePage, "doc">;
    const data: CmsPageData = {
      doc,
      path: slugToPath(doc.seo.slug),
      parents: result.parents,
    };
    if (result.posts) {
      data.posts = postsOf(result.posts);
    }
    if (result.preview) {
      data.preview = true;
    }
    return data;
  } catch (err) {
    console.error("cmsPageData: unreadable CMS page value", err);
    return null;
  }
}

/** `posts:index` text as a list; an unreadable value is no posts (the page still renders). */
function postsOf(text: string): PostSummary[] {
  try {
    const posts: unknown = JSON.parse(text);
    return Array.isArray(posts) ? (posts as PostSummary[]) : [];
  } catch {
    return [];
  }
}

/** Follows the CMS redirect in `result`, if any: a 301 that keeps the request's query string (`search`, e.g. "?a=1"). */
export function throwCmsRedirect(result: CmsPageResult, search: string): void {
  if ("redirect" in result) {
    throw redirect({ href: `${result.redirect}${search}`, statusCode: 301 });
  }
}

/** For a loader with nothing to show: follow the CMS redirect if there is one, else 404. */
export function throwCmsMiss(result: CmsPageResult, search: string): never {
  throwCmsRedirect(result, search);
  throw notFound();
}

// ---------------------------------------------------------------------------------------------
// Draft previews (docs/cms-plan.md §3.6)

/** Longer than any real token (render-token.ts MAX_TOKEN_LENGTH); not worth a server call. */
const MAX_PREVIEW_TOKEN_LENGTH = 1024;

/**
 * The `?_preview=` token from a loader's `location.search`, for `loadCmsPage`. Only the server
 * decides whether it is valid. The router JSON-parses search values, so anything but a non-empty
 * string is ignored.
 */
export function previewToken(search: unknown): string | undefined {
  const token =
    typeof search === "object" && search !== null
      ? (search as Record<string, unknown>)._preview
      : undefined;
  return typeof token === "string" &&
    token.length > 0 &&
    token.length <= MAX_PREVIEW_TOKEN_LENGTH
    ? token
    : undefined;
}

/** Response headers for a draft preview: never cached, never indexed. */
export const PREVIEW_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

/** A route's `headers` option: `PREVIEW_HEADERS` when it shows a draft preview. */
export function cmsHeaders(
  cms: CmsPageData | null | undefined
): Record<string, string> | undefined {
  return cms?.preview ? PREVIEW_HEADERS : undefined;
}

type HeadMatches = Parameters<typeof siteSeoFromMatches>[0];

/**
 * `buildHead` for a CMS page, with the SiteConfig and the site doc's SEO defaults from the root
 * match (`matches`, as a route `head` gets them); a draft preview is always `noindex, nofollow`,
 * whatever its SEO settings.
 */
export function cmsHead(
  cms: CmsPageData,
  matches: HeadMatches
): ReturnType<typeof buildHead> {
  const head = buildHead(
    cms.doc,
    cms.path,
    siteConfigFromMatches(matches),
    siteSeoFromMatches(matches)
  );
  if (!cms.preview) {
    return head;
  }
  return {
    ...head,
    meta: head.meta.map((m) =>
      "name" in m && m.name === "robots"
        ? { name: "robots", content: "noindex, nofollow" }
        : m
    ),
  };
}
