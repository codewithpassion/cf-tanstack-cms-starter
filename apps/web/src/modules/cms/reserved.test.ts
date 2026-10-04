import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isReservedSlug, STATIC_PAGE_SLUGS } from "@repo/cms-core/reserved";

const ROUTES = join(import.meta.dir, "..", "..", "routes");
const ROUTE_FILE_RE = /\.(tsx|ts)$/;
const ESCAPED_DOT_RE = /\[\.\]/g;
const ESCAPED_DOT = "\u0000";
const SEGMENT_SEPARATOR_RE = /[./]/;

/**
 * Full paths of every file route, from the route files themselves (TanStack flat-file naming):
 * `.` and directories separate segments, `[.]` is a literal dot, `index` is the parent path,
 * `_layout` segments are pathless, a trailing `_` un-nests, `-` files and `(group)` folders are
 * ignored, `$name`/`$` are dynamic.
 */
function routePaths(): string[] {
  const files = readdirSync(ROUTES, { recursive: true, encoding: "utf8" });
  return files
    .filter((f) => ROUTE_FILE_RE.test(f) && !f.includes(".test."))
    .map((f) => relative(ROUTES, join(ROUTES, f)).replace(ROUTE_FILE_RE, ""))
    .filter((f) => !f.split("/").some((part) => part.startsWith("-")))
    .filter((f) => f !== "__root")
    .map((f) => {
      const segments = f
        .replace(ESCAPED_DOT_RE, ESCAPED_DOT)
        .split(SEGMENT_SEPARATOR_RE)
        .map((s) => s.replaceAll(ESCAPED_DOT, "."))
        .filter((s) => !(s.startsWith("_") || s.startsWith("(")))
        .map((s) => (s.endsWith("_") ? s.slice(0, -1) : s));
      if (segments.at(-1) === "index") {
        segments.pop();
      }
      return `/${segments.join("/")}`;
    });
}

/** The dynamic route the CMS serves: the catch-all `$` (CMS pages at any path no other route owns). */
const CMS_DYNAMIC = new Set(["/$"]);

describe("reserved slugs vs the route files", () => {
  const paths = routePaths();

  it("finds the routes", () => {
    expect(paths).toContain("/login");
    expect(paths).toContain("/$");
    expect(paths).toContain("/");
  });

  it("reserves every static route (drift guard: add new routes to cms-core reserved.ts)", () => {
    const missing = paths
      .filter((p) => !p.includes("$"))
      .map((p) => p.slice(1))
      .filter((slug) => slug !== "" && !isReservedSlug(slug));
    expect(missing).toEqual([]);
  });

  it("reserves the prefix of every dynamic route the CMS doesn't share", () => {
    const missing = paths
      .filter((p) => p.includes("$") && !CMS_DYNAMIC.has(p))
      .map((p) => p.slice(1).split("/$")[0])
      .filter((prefix) => !isReservedSlug(`${prefix}/any-slug`));
    expect(missing).toEqual([]);
  });

  it("lists only static pages that exist as routes", () => {
    const statics = new Set(paths.map((p) => p.slice(1)));
    expect(STATIC_PAGE_SLUGS.filter((slug) => !statics.has(slug))).toEqual([]);
  });
});
