/**
 * The home page is a CMS page (slug ""). With none published it shows a short notice pointing to
 * /admin and the starter content import, instead of a 404. A KV redirect for the home slug is
 * ignored: the front door never moves.
 */
import { createFileRoute } from "@tanstack/react-router";
import { getTrpc } from "#/integrations/trpc/client";
import { CmsPage } from "#/modules/cms/render/cms-page";
import {
  cmsHead,
  cmsHeaders,
  cmsPageData,
  previewToken,
} from "#/modules/cms/render/cms-result";
import { siteConfigFromMatches } from "#/modules/cms/site/site-context";

export const Route = createFileRoute("/")({
  // The preview token is a loader dependency: navigating to the same page with or without one re-runs the loader.
  loaderDeps: ({ search }) => ({ preview: previewToken(search) }),
  loader: async ({ deps }) =>
    cmsPageData(
      await getTrpc().cms.public.loadCmsPage.query({
        path: "/",
        preview: deps.preview,
      })
    ),
  // A draft preview is never cached or indexed.
  headers: ({ loaderData }) => cmsHeaders(loaderData),
  head: ({ loaderData, matches }) =>
    loaderData
      ? cmsHead(loaderData, matches)
      : {
          meta: [
            { title: siteConfigFromMatches(matches).name },
            { name: "robots", content: "noindex" },
          ],
        },
  // Split from the route (TanStack code splitting), so the renderer stays out of the entry chunk.
  component: Home,
});

function Home() {
  const cms = Route.useLoaderData();
  if (!cms) {
    return <NothingPublished />;
  }
  return <CmsPage {...cms} />;
}

/** The home page before anything is published: where to go to fill the site. */
function NothingPublished() {
  return (
    <main className="page-wrap px-4 py-24 text-center">
      <h1 className="display-title text-3xl">Nothing published yet.</h1>
      <p className="mt-4 text-muted-foreground">
        Sign in to <a href="/admin">/admin</a> and import the starter content.
      </p>
    </main>
  );
}
