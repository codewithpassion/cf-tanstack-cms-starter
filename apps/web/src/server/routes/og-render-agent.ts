import { parseShareQuery } from "@repo/cms-core/share/params";
import type { PageDoc, PageKind } from "@repo/cms-core/types";
import {
  type AgentRenderDeps,
  authorizeAgentRender,
} from "@repo/services/agent/render-auth";
import { getPage } from "@repo/services/cms/pages-service";
import type { CmsServices } from "../cms/wiring.ts";

/**
 * Server side of the agent's render target `/og-render-agent/<pageId>?t=<token>[&cs=<changesetId>]`
 * (routes/og-render-agent.$pageId.tsx): Browser Run loads it to screenshot a page's DRAFT, or a
 * staged agent changeset's proposed page, without a Clerk session. The credential is a short-lived
 * "og" render token bound to the page's id and current slug (services agent/render-auth). Two
 * checks use this module: the route's request gate (og-render-agent-gate.ts, before anything
 * renders) and the public `agentRender.getAgentRenderData` procedure the loader calls, which is
 * reachable over /api/trpc and so re-checks the token. No `cloudflare:workers` here.
 */

const AGENT_RENDER_PREFIX = "/og-render-agent/";

const plain = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });

const param = (search: Record<string, unknown>, key: string): string | null => {
  const value = search[key];
  return typeof value === "string" ? value : null;
};

/** The page id in `/og-render-agent/<pageId>`, or null for any other path or a bad escape. */
export const agentRenderPageId = (pathname: string): string | null => {
  if (!pathname.startsWith(AGENT_RENDER_PREFIX)) {
    return null;
  }
  try {
    const id = decodeURIComponent(pathname.slice(AGENT_RENDER_PREFIX.length));
    return id || null;
  } catch {
    return null;
  }
};

/** The render check's deps over the request's CMS services (the signer, D1 pages, the agent store). */
export const agentRenderDeps = (
  cms: Pick<CmsServices, "signer" | "pagesDeps" | "agentStore">
): AgentRenderDeps => ({
  signer: cms.signer,
  loadPage: (id) => getPage(cms.pagesDeps, { id }),
  loadChangeset: (id) => cms.agentStore.getChangeset(id),
});

/** The page's draft (or the proposal `cs` names) when `search.t` is a valid "og" token for the page. */
const authorized = (
  deps: AgentRenderDeps,
  pageId: string,
  search: Record<string, unknown>
) =>
  authorizeAgentRender(deps, pageId, param(search, "t"), param(search, "cs"));

/**
 * The request gate's check: 403 unless the path names a page and the token is valid for it (and
 * `cs`, when given, is a proposal for that page); null lets the route render. The query is read
 * with `parseShareQuery`, which parses like the router's `defaultParseSearch`, so the gate checks
 * the values the loader receives.
 */
export const checkAgentRenderRequest = async (
  deps: AgentRenderDeps,
  url: URL
): Promise<Response | null> => {
  const pageId = agentRenderPageId(url.pathname);
  const search = parseShareQuery(url.search);
  if (!(pageId && (await authorized(deps, pageId, search)))) {
    return plain(403, "Forbidden");
  }
  return null;
};

/** A rendered agent preview is never cached and never indexed. */
export const markUncacheable = (response: Response): void => {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
};

/** The loader's data: what to render, or null when the token or page doesn't check out. */
export const readAgentRenderData = async (
  deps: AgentRenderDeps,
  input: { pageId: string; search: Record<string, unknown> }
): Promise<{ doc: PageDoc; kind: PageKind } | null> => {
  const found = await authorized(deps, input.pageId, input.search);
  return found ? { doc: found.doc, kind: found.page.kind } : null;
};
