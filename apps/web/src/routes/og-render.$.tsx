/**
 * Share-image render target: `/og-render/<slug>?t=<token>&template=…` renders the page's DRAFT as a
 * 1200×630 card for Browser Run to screenshot. The request gate (server/routes/og-render-gate.ts)
 * answers 403 without a valid "og" token before anything renders; responses are noindex and
 * no-store. Clerk is skipped for /og-render* (lib/clerk-skip.ts): Browser Run carries no cookies.
 * Search validation is a pass-through: the procedure parses it on the server.
 */
import { createFileRoute, notFound } from "@tanstack/react-router";
import { getTrpc } from "#/integrations/trpc/client";
import { OgCard } from "#/modules/cms/share/og-card";
import { ogTokenGate } from "#/server/routes/og-render-gate";

const TRAILING_SLASHES_RE = /\/+$/;

const OgRender = () => {
  const { doc, kind, params } = Route.useLoaderData();
  return <OgCard doc={doc} kind={kind} params={params} />;
};

export const Route = createFileRoute("/og-render/$")({
  server: { middleware: [ogTokenGate] },
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ params, deps }) => {
    const slug = (params._splat ?? "").replace(TRAILING_SLASHES_RE, "");
    const data = await getTrpc().cms.ogRender.getOgRenderData.query({
      slug,
      search: deps.search,
    });
    if (!data) {
      throw notFound();
    }
    return data;
  },
  head: () => ({
    meta: [
      { title: "Share image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    // Nothing below the 1200×630 frame, and no scrollbars in the screenshot.
    styles: [
      { children: "html,body{margin:0;overflow:hidden;background:#000}" },
    ],
  }),
  component: OgRender,
});
