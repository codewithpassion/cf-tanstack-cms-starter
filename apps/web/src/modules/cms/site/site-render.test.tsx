// biome-ignore-all lint/performance/useTopLevelRegex: ported from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported from the source test (kept diffable); test-only idiom.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { defaultSiteDoc, publicSite } from "@repo/cms-core/site/defaults";
import { TEST_SITE } from "@repo/cms-core/site/test-site";
import type { PublicSite } from "@repo/cms-core/site/types";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";

import { Footer } from "#/components/footer";
import { Navigation } from "#/components/navigation";

import { SiteConfigProvider, SiteContext } from "./site-context";

// These tests render inside a real memory router (bun's module mocks are process-wide), on /about.

beforeAll(() => setSystemTime(new Date("2026-10-02T12:00:00Z")));
afterAll(() => setSystemTime());

const render = async (site?: PublicSite | null) => {
  const shell = () => (
    <>
      <Navigation />
      <Footer />
    </>
  );
  const rootRoute = createRootRoute({
    component: () => (
      <SiteConfigProvider value={TEST_CONFIG}>
        {site === undefined ? (
          shell()
        ) : (
          <SiteContext.Provider value={site}>{shell()}</SiteContext.Provider>
        )}
      </SiteConfigProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/about"] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
};

const testSite = () => structuredClone(publicSite(TEST_SITE));

describe("Navigation + Footer from the site doc", () => {
  it("render the defaults with no site doc: site name, nav links and button, footer column and copyright", async () => {
    const html = await render();
    expect(html).toContain(`>${TEST_CONFIG.name}</a>`);
    expect(html).toContain('href="/blog"');
    expect(html).toContain(">Get in touch<");
    expect(html).toContain(">Edit me: a short line about the site.<");
    expect(html).toContain(
      `© <!-- -->2026<!-- --> ${TEST_CONFIG.name}. All rights reserved.`
    );
    // The empty text column ("About") is left out.
    expect(html).not.toContain(">About<");
  });

  it("render the same with the defaults provided explicitly, or a null (missing) doc", async () => {
    const html = await render();
    expect(await render(publicSite(defaultSiteDoc(TEST_CONFIG)))).toBe(html);
    expect(await render(null)).toBe(html);
  });

  it("render a published doc: a new nav link with a dropdown, a renamed footer column, new copyright", async () => {
    const site = testSite();
    site.nav.links.push({
      _key: "cms",
      label: "CMS Test",
      href: "/cms-test",
      children: [{ _key: "cms-a", label: "Sub page", href: "/cms-test/sub" }],
    });
    site.nav.cta = { label: "Talk to us", href: "/contact" };
    site.footer.columns[1]!.title = "What we do";
    site.footer.copyright = "Example Co Ltd.";
    site.footer.legalLinks = [];
    const html = await render(site);
    // Desktop and mobile menus both list it (the mobile menu renders when opened; here: desktop).
    expect(html).toContain('href="/cms-test"');
    expect(html).toContain(">CMS Test<");
    expect(html).toContain('href="/cms-test/sub"');
    expect(html).toContain("group-hover:block");
    expect(html).toContain(">Talk to us<");
    expect(html).not.toContain("Book a Free Call");
    expect(html).toContain(">What we do<");
    expect(html).toContain("© <!-- -->2026<!-- --> Example Co Ltd.");
    expect(html).not.toContain("Privacy Policy");
  });

  it("render paths with $, { or } (published before they were refused) as plain anchors, not router links", async () => {
    const site = testSite();
    site.footer.columns[0]!.links.push({
      _key: "odd",
      label: "Odd",
      href: "/a$b{c}",
    });
    const html = await render(site);
    expect(html).toMatch(/<a href="\/a\$b\{c\}" class="[^"]*">Odd<\/a>/);
    // A router Link renders its props before `href`; SiteHref's plain anchor puts `href` first.
    expect(html).toMatch(/<a class="[^"]*" href="\/process">Process<\/a>/);
  });

  it("give dropdown parents a separate toggle button with aria state, and highlight the parent on a child's page", async () => {
    const site = testSite();
    site.nav.links = [
      {
        _key: "co",
        label: "Company",
        href: "/company",
        children: [{ _key: "ab", label: "About", href: "/about" }],
      },
      { _key: "bl", label: "Blog", href: "/blog" },
    ];
    const html = await render(site);
    // Active links end in a bare `text-primary`; idle ones only have `hover:text-primary`.
    expect(html).toMatch(
      /<button aria-controls="nav-menu-co" aria-expanded="false" aria-haspopup="true" aria-label="Company menu" class="[^"]* text-primary" type="button">/
    );
    expect(html).toContain('id="nav-menu-co"');
    // /about is the current page: its parent "Company" is highlighted with the underline; "Blog" isn't.
    expect(html).toMatch(
      /class="relative [^"]* text-primary"[^>]*href="\/company"[^>]*>Company<span class="absolute -bottom-1/
    );
    expect(html).toMatch(
      /class="relative [^"]*text-muted-foreground hover:text-primary"[^>]*href="\/blog"[^>]*>Blog<\/a>/
    );
  });

  it("size the footer grid to its columns (brand + link columns + text column when it has items)", async () => {
    const grid = async (n: number, highlights: boolean) => {
      const site = testSite();
      site.footer.columns = Array.from({ length: n }, (_, i) => ({
        _key: `c${i}`,
        title: `C${i}`,
        links: [],
      }));
      if (!highlights) {
        site.footer.highlights.items = [];
      }
      return (await render(site)).match(
        /grid grid-cols-1 gap-8 md:grid-cols-2 (lg:grid-cols-\d)/
      )?.[1];
    };
    expect([
      await grid(0, true),
      await grid(1, true),
      await grid(3, true),
      await grid(6, true),
      await grid(1, false),
    ]).toEqual([
      "lg:grid-cols-2",
      "lg:grid-cols-3",
      "lg:grid-cols-5",
      "lg:grid-cols-8",
      "lg:grid-cols-2",
    ]);
  });

  it("render external links as plain anchors", async () => {
    const site = testSite();
    site.footer.columns[0]!.links.push({
      _key: "li",
      label: "Profile",
      href: "https://example.org/company/x",
    });
    expect(await render(site)).toContain(
      '<a href="https://example.org/company/x" class="text-muted-foreground'
    );
  });
});
