/**
 * The access check behind `/og-render-agent/<pageId>` (a web route), kept free of
 * Cloudflare bindings so it can be tested. The token is verified before anything is read from
 * D1, so an anonymous request costs no database read; the loaded page must then be the one the
 * token was minted for (same id and current slug).
 */

import type { PageDoc } from "@repo/cms-core/types";
import {
  logTokenError,
  type RenderSigner,
  RenderTokenConfigError,
  verifyRenderToken,
} from "../cms/render-token";
import type { PageRow } from "../cms/repo";

export type AgentRenderPage = Pick<
  PageRow,
  "id" | "slug" | "kind" | "status" | "draftDoc"
>;

export type AgentRenderDeps = {
  /** `{ signingKey }`: the web adapter reads `PREVIEW_SIGNING_KEY` into it (D6). */
  signer: RenderSigner;
  loadPage: (id: string) => Promise<AgentRenderPage | null>;
  loadChangeset: (
    id: string
  ) => Promise<{ pageId: string; proposedDoc: PageDoc } | null>;
};

/** The page's draft (or a changeset's proposed page) when `token` is a valid "og" token for this page. */
export async function authorizeAgentRender(
  deps: AgentRenderDeps,
  pageId: string,
  token: string | null,
  changesetId: string | null
): Promise<{ page: AgentRenderPage; doc: PageDoc } | null> {
  let claims: { slug: string; pageId?: string };
  try {
    // The slug isn't known until the page is loaded; it is compared below.
    const res = await verifyRenderToken(deps.signer, token, {
      slug: null,
      purpose: "og",
    });
    if (!res.ok || res.claims.pageId !== pageId) {
      return null;
    }
    ({ claims } = res);
  } catch (err) {
    if (err instanceof RenderTokenConfigError) {
      logTokenError("agent render:", err);
      return null;
    }
    throw err;
  }
  const page = await deps.loadPage(pageId);
  if (
    !page?.draftDoc ||
    page.status === "archived" ||
    page.id !== claims.pageId ||
    page.slug !== claims.slug
  ) {
    return null;
  }
  if (!changesetId) {
    return { page, doc: page.draftDoc };
  }
  const cs = await deps.loadChangeset(changesetId);
  if (!cs || cs.pageId !== page.id) {
    return null;
  }
  return { page, doc: cs.proposedDoc };
}
