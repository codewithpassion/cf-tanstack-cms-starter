import { describe, expect, it } from "bun:test";
import { createBlock } from "@repo/cms-core/blocks/registry";
import { post } from "@repo/cms-core/ops/test-docs";
import { sampleSeo, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import type { PageDoc } from "@repo/cms-core/types";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";

import { SiteConfigProvider } from "../site/site-context";
import { CmsPage } from "./cms-page";
import type { CmsPageData } from "./cms-result";

const SITE_NAV = '<nav aria-label="Main"';
const SITE_FOOTER = "<footer";
const JSON_LD_RE = /<script type="application\/ld\+json">/g;

// The nav and footer use router links, so the page renders inside a memory router (as site-render.test.tsx).
async function render(
  page: PageDoc,
  extra: Partial<CmsPageData> = {}
): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => (
      <SiteConfigProvider value={TEST_CONFIG}>
        <CmsPage doc={page} parents={[]} path="/x" {...extra} />
      </SiteConfigProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/x"] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

const doc = (chrome?: PageDoc["chrome"]): PageDoc => ({
  _schema: 1,
  seo: sampleSeo(),
  ...(chrome && { chrome }),
  blocks: [createBlock("stats", { _key: "s" })],
});

describe("CmsPage chrome", () => {
  it("wraps a page in the site nav and footer by default", async () => {
    const pages = await Promise.all([render(doc()), render(doc("site"))]);
    for (const html of pages) {
      expect(html).toContain(SITE_NAV);
      expect(html).toContain(SITE_FOOTER);
    }
  });

  it("leaves both out for chrome: none", async () => {
    const html = await render(doc("none"));
    expect(html).not.toContain(SITE_NAV);
    expect(html).not.toContain(SITE_FOOTER);
    expect(html).toContain("Years of experience");
  });
});

describe("CmsPage", () => {
  it("emits the page's JSON-LD with the SiteConfig origin", async () => {
    const html = await render(doc());
    expect(html.match(JSON_LD_RE)?.length).toBeGreaterThan(0);
    expect(html).toContain(TEST_CONFIG.origin);
  });

  it("shows the preview banner only on a draft preview", async () => {
    expect(await render(doc())).not.toContain('data-testid="preview-banner"');
    expect(await render(doc(), { preview: true })).toContain(
      'data-testid="preview-banner"'
    );
  });

  it("renders a post in the post layout, with its closing call to action", async () => {
    const html = await render(
      { ...doc(), post: post({ title: "A post" }) },
      { path: "/blog/a" }
    );
    expect(html).toContain(">A post</h1>");
    expect(html).toContain('href="/contact"');
    expect(html).toContain(SITE_NAV);
  });
});
