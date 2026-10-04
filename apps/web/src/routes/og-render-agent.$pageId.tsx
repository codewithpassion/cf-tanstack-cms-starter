/**
 * Agent preview render target: `/og-render-agent/<pageId>?t=<token>[&cs=<changesetId>]` renders a
 * page's DRAFT (or the proposed page of a staged agent changeset, `cs`) in the site's shell,
 * static (no fade-ins, forms inert), for Browser Run to screenshot at a device width. The request
 * gate (server/routes/og-render-agent-gate.ts) answers 403 without a valid "og" token for the page
 * before anything renders; responses are noindex and no-store. Clerk is skipped for
 * /og-render-agent/ (lib/clerk-skip.ts): Browser Run carries no cookies. The site's nav and footer
 * frame the page unless it sets `chrome: "none"`, as on the public site. Search validation is a
 * pass-through: the procedure parses it on the server.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Footer } from "#/components/footer";
import { Navigation } from "#/components/navigation";
import { getTrpc } from "#/integrations/trpc/client";
import { EditModeContext } from "#/modules/cms/render/edit-mode";
import { PageRenderer } from "#/modules/cms/render/page-renderer";
import { PostLayout } from "#/modules/cms/render/post-layout";
import { CmsRenderContext } from "#/modules/cms/render/render-context";
import { agentRenderGate } from "#/server/routes/og-render-agent-gate";

const EDIT_MODE = { editing: true, selectedKey: null };

const AgentRender = () => {
  const { doc, posts } = Route.useLoaderData();
  const siteChrome = doc.chrome !== "none";
  return (
    <EditModeContext.Provider value={EDIT_MODE}>
      <div className="overflow-x-clip" data-agent-render="">
        {siteChrome && <Navigation />}
        <CmsRenderContext.Provider value={{ posts }}>
          {doc.post ? (
            <PostLayout doc={doc} post={doc.post}>
              <PageRenderer doc={doc} />
            </PostLayout>
          ) : (
            <PageRenderer doc={doc} />
          )}
        </CmsRenderContext.Provider>
        {siteChrome && <Footer />}
      </div>
    </EditModeContext.Provider>
  );
};

export const Route = createFileRoute("/og-render-agent/$pageId")({
  server: { middleware: [agentRenderGate] },
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) =>
    getTrpc().cms.agentRender.getAgentRenderData.query({
      pageId: params.pageId,
      search: deps.search,
    }),
  head: () => ({
    meta: [
      { title: "Agent preview" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AgentRender,
});
