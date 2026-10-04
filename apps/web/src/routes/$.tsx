/**
 * CMS pages at every path no other route owns, single-segment and nested: the published page, its
 * draft through a preview link, a 301 left by a slug change, else 404.
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

export const Route = createFileRoute("/$")({
  // The preview token is a loader dependency: navigating to the same page with or without one re-runs the loader.
  loaderDeps: ({ search }) => ({ preview: previewToken(search) }),
  loader: async ({ params, location, deps }) => {
    const result = await getTrpc().cms.public.loadCmsPage.query({
      path: `/${params._splat ?? ""}`,
      preview: deps.preview,
    });
    const cms = cmsPageData(result);
    return cms ?? throwCmsMiss(result, location.searchStr);
  },
  // A draft preview is never cached or indexed.
  headers: ({ loaderData }) => cmsHeaders(loaderData),
  head: ({ loaderData, matches }) =>
    loaderData ? cmsHead(loaderData, matches) : {},
  // The component chunk is split from the route (TanStack code splitting), so `CmsPage` and the
  // block registry load only here, not in the entry chunk.
  component: CmsSplatPage,
  notFoundComponent: NotFoundPage,
});

function CmsSplatPage() {
  return <CmsPage {...Route.useLoaderData()} />;
}
