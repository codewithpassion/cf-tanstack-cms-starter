import { createFileRoute } from "@tanstack/react-router";

import { redirectOnUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import { SiteEditor } from "#/modules/cms/site/site-editor";

/** /admin/site: the site settings document (nav, footer, SEO defaults, swatches); see site-editor.tsx. */
export const Route = createFileRoute("/admin/_shell/site")({
  head: () => ({ meta: [{ title: "Site | Admin" }] }),
  // Always fresh: another tab may have saved or published.
  gcTime: 0,
  loader: ({ location }) =>
    redirectOnUnauthorized(getTrpc().cms.site.getSite.query(), location.href),
  component: SitePage,
});

function SitePage() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return <p className="p-8 text-danger">{result.message}</p>;
  }
  return <SiteEditor initial={result} />;
}
