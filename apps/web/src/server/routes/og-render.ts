import { isValidSlug } from "@repo/cms-core/paths";
import {
  ogSlugFromPath,
  parseShareParams,
  parseShareQuery,
  type ShareParams,
} from "@repo/cms-core/share/params";
import type { PageDoc, PageKind } from "@repo/cms-core/types";
import {
  logTokenError,
  type RenderSigner,
  RenderTokenConfigError,
  verifyRenderToken,
} from "@repo/services/cms/render-token";

/**
 * Server side of the share-image render target `/og-render/<slug>?t=<token>&template=…`: Browser
 * Run loads it with a short-lived "og" render token, so it renders a page's DRAFT without a Clerk
 * session. Two checks use this module: the route's request gate (og-render-gate.ts, before
 * anything renders) and the `ogRender.getOgRenderData` procedure the loader calls, which is public
 * over /api/trpc and so re-checks the token itself. No `cloudflare:workers` here: callers pass the
 * signer and the page lookup.
 */

const plain = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });

/** Whether `token` is a valid "og" token for `slug`. No usable signing key: nothing renders. */
export const ogTokenValid = async (
  signer: RenderSigner,
  slug: string,
  token: string | null
): Promise<boolean> => {
  try {
    return (await verifyRenderToken(signer, token, { slug, purpose: "og" })).ok;
  } catch (err) {
    if (err instanceof RenderTokenConfigError) {
      logTokenError("og-render:", err);
      return false;
    }
    throw err;
  }
};

const tokenOf = (search: Record<string, unknown>): string | null =>
  typeof search.t === "string" ? search.t : null;

/**
 * The request gate's check: 403 without a valid "og" token for this slug, 400 for bad template
 * parameters, null to let the route render. The query is read with `parseShareQuery`, which parses
 * like the router's `defaultParseSearch`, so the gate checks the values the loader receives.
 */
export const checkOgRequest = async (
  signer: RenderSigner,
  url: URL
): Promise<Response | null> => {
  const slug = ogSlugFromPath(url.pathname);
  const search = parseShareQuery(url.search);
  if (slug === null || !(await ogTokenValid(signer, slug, tokenOf(search)))) {
    return plain(403, "Forbidden");
  }
  const params = parseShareParams(search);
  if (!params.ok) {
    return plain(400, `Bad share-image parameters: ${params.error}`);
  }
  return null;
};

/** A rendered share card is never cached and never indexed. */
export const markUncacheable = (response: Response): void => {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
};

export type OgRenderData =
  | { ok: true; doc: PageDoc; kind: PageKind; params: ShareParams }
  | {
      ok: false;
      reason: "forbidden" | "not-found" | "bad-params";
      message: string;
    };

export type OgRenderDeps = {
  signer: RenderSigner;
  /** The page by slug (not archived), or null. */
  findPage: (
    slug: string
  ) => Promise<{ draftDoc: PageDoc | null; kind: PageKind } | null>;
};

/** The loader's data: the page's draft and the parsed template parameters, behind the token. */
export const readOgRenderData = async (
  deps: OgRenderDeps,
  input: { slug: string; search: Record<string, unknown> }
): Promise<OgRenderData> => {
  const { slug, search } = input;
  if (
    !(
      isValidSlug(slug) &&
      (await ogTokenValid(deps.signer, slug, tokenOf(search)))
    )
  ) {
    return { ok: false, reason: "forbidden", message: "Forbidden" };
  }
  const params = parseShareParams(search);
  if (!params.ok) {
    return { ok: false, reason: "bad-params", message: params.error };
  }
  const page = await deps.findPage(slug);
  if (!page?.draftDoc) {
    return { ok: false, reason: "not-found", message: "Page not found" };
  }
  return {
    ok: true,
    doc: page.draftDoc,
    kind: page.kind,
    params: params.params,
  };
};
