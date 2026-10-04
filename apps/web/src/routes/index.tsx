/**
 * The home page is a CMS page (slug ""). With none published it shows a short notice pointing to
 * /admin and the starter content import, instead of a 404. A KV redirect for the home slug is
 * ignored: the front door never moves.
 */
import { createFileRoute } from "@tanstack/react-router";
import { LogoMark } from "#/components/logo";
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
    <main className="page-wrap flex min-h-[70dvh] flex-col items-center justify-center px-4 py-24 text-center">
      <LogoMark className="mb-6 size-12" />
      <h1 className="display-title text-3xl sm:text-4xl">
        Nothing published yet
      </h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        Your site is running. Sign in to the admin to import the starter
        content, or build your first page.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <a
          className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground text-sm shadow-soft transition-colors hover:bg-primary/90"
          href="/admin/setup"
        >
          Import starter content
        </a>
        <a
          className="rounded-md border border-border bg-background px-5 py-2.5 font-medium text-sm shadow-soft transition-colors hover:bg-accent"
          href="/admin"
        >
          Open the admin
        </a>
      </div>
    </main>
  );
}
