import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATIC_PAGE_SLUGS } from "@repo/cms-core/reserved";
import { staticPageTitles } from "@repo/cms-core/static-titles";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";

const ROUTES = join(import.meta.dir, "..", "..", "routes");

/** The root loader's data, as every route `head` reads it (site-context.ts): no site doc, the test SiteConfig. */
const ROOT_DATA = { site: null, config: TEST_CONFIG };
const MATCHES = [{ routeId: "__root__", loaderData: ROOT_DATA }];

type HeadFn = (ctx: {
  loaderData: unknown;
  matches: typeof MATCHES;
}) => { meta?: unknown[] } | undefined;
type RouteModule = { Route: { options: { head?: HeadFn } } };

/** The route file for a static slug: `blog` → blog.index.tsx, `login` → login.tsx. */
function routeFile(slug: string): string {
  const base = slug.replace(/\//g, ".");
  const index = join(ROUTES, `${base}.index.tsx`);
  return existsSync(index) ? index : join(ROUTES, `${base}.tsx`);
}

function titleIn(head: { meta?: unknown[] } | undefined): string | undefined {
  for (const tag of head?.meta ?? []) {
    if (typeof tag === "object" && tag !== null && "title" in tag) {
      return String(tag.title);
    }
  }
}

/** The `<title>` a route renders: its own head's, else the root route's (the SiteConfig name). */
async function routeTitle(file: string): Promise<string | undefined> {
  const { Route } = (await import(file)) as RouteModule;
  const own = titleIn(
    Route.options.head?.({ loaderData: undefined, matches: MATCHES })
  );
  if (own !== undefined) {
    return own;
  }
  const root = (await import(join(ROUTES, "__root.tsx"))) as RouteModule;
  return titleIn(
    root.Route.options.head?.({ loaderData: ROOT_DATA, matches: MATCHES })
  );
}

describe("staticPageTitles vs the routes", () => {
  const titles = staticPageTitles(TEST_CONFIG);

  it.each([...STATIC_PAGE_SLUGS])(
    "%s: matches the route's head title",
    async (slug) => {
      const file = routeFile(slug);
      expect(existsSync(file), `no route file for "${slug}": ${file}`).toBe(
        true
      );
      expect(await routeTitle(file)).toBe(titles[slug]);
    }
  );
});
