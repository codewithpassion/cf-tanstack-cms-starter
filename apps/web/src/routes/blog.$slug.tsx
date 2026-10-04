/**
 * A blog post: the CMS post at `blog/<slug>` (KV `page:blog/<slug>`), or its draft through a
 * preview link. Renamed posts redirect; anything else is a 404.
 */
import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "#/components/not-found-page";
import { getTrpc } from "#/integrations/trpc/client";
import { CmsPage } from "#/modules/cms/render/cms-page";
import {
  cmsHead,
  cmsHeaders,
  cmsPageData,
  previewToken,
  throwCmsMiss,
} from "#/modules/cms/render/cms-result";
import { siteConfigFromMatches } from "#/modules/cms/site/site-context";

export const Route = createFileRoute("/blog/$slug")({
  // The preview token is a loader dependency: navigating to the same post with or without one re-runs the loader.
  loaderDeps: ({ search }) => ({ preview: previewToken(search) }),
  loader: async ({ params, location, deps }) => {
    const result = await getTrpc().cms.public.loadCmsPage.query({
      path: `/blog/${params.slug}`,
      preview: deps.preview,
    });
    const cms = cmsPageData(result);
    // Only posts live under blog/ (pages-service checkKind); a doc without post metadata isn't one.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: `post` is optional (only posts have it).
    if (!cms?.doc.post) {
      return throwCmsMiss(result, location.searchStr);
    }
    return cms;
  },
  // A draft preview is never cached or indexed.
  headers: ({ loaderData }) => cmsHeaders(loaderData),
  head: ({ loaderData, matches }) =>
    loaderData
      ? cmsHead(loaderData, matches)
      : {
          meta: [
            {
              title: `Article not found | ${siteConfigFromMatches(matches).name}`,
            },
          ],
        },
  notFoundComponent: NotFoundPage,
  // The component chunk is split from the route, so the post layout and the block registry load only here.
  component: BlogPostPage,
});

function BlogPostPage() {
  return <CmsPage {...Route.useLoaderData()} />;
}
