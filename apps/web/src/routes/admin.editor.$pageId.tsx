import { editorPageFromWire } from "@repo/cms-core/admin-result";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { redirectOnUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import { SwatchesContext } from "#/modules/cms/editor/swatches";

/**
 * The page editor. Client-only (`ssr: false`): the loader calls tRPC from the browser, and the
 * editor itself is a lazy chunk, so TipTap, dnd-kit and the block registry never reach the public
 * bundle. The admin check happens in the procedures; a signed-out visitor is sent to sign in.
 */
const PageEditor = lazy(() => import("#/modules/cms/editor/page-editor"));

export const Route = createFileRoute("/admin/editor/$pageId")({
  ssr: false,
  // Always load the draft fresh: a cached one would be stale after edits elsewhere.
  gcTime: 0,
  loader: async ({ params, location }) => {
    const [res, site] = await Promise.all([
      redirectOnUnauthorized(
        getTrpc().cms.pages.getEditorPage.query({ id: params.pageId }),
        location.href
      ),
      // The colour picker's saved swatches; the editor works without them.
      getTrpc()
        .cms.site.getSiteSwatches.query()
        .catch(() => null),
    ]);
    const swatches = site?.ok ? site.swatches : [];
    return res.ok
      ? { ok: true as const, ...editorPageFromWire(res), swatches }
      : res;
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.ok ? `Edit ${loaderData.page.title}` : "Editor"} | Admin`,
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  pendingComponent: Loading,
  component: EditorRoute,
});

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-background font-sans text-muted-foreground">
      Loading editor…
    </div>
  );
}

function EditorRoute() {
  const data = Route.useLoaderData();
  const { pageId } = Route.useParams();
  if (!data.ok) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background font-sans text-foreground">
        <p>
          {data.code === "NOT_FOUND"
            ? "That page doesn't exist."
            : data.message}
        </p>
        <Link className="text-primary underline" to="/admin/pages">
          Back to pages
        </Link>
      </div>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <SwatchesContext.Provider value={data.swatches}>
        <PageEditor initial={data} key={pageId} pageId={pageId} />
      </SwatchesContext.Provider>
    </Suspense>
  );
}
