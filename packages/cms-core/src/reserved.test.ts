import { describe, expect, it } from "bun:test";

import { isCmsServable } from "./reserved";

describe("reserved slugs", () => {
  it.each([
    ["", true],
    ["about", true],
    ["about/team", true],
    ["cms-test", true],
    ["services/new-thing", true],
    ["guides/a/b", true],
    ["blog/post", true],
    ["blog", false],
    ["login", false],
    ["dev-login", false],
    ["admin", false],
    ["admin/pages", false],
    ["api/x", false],
    ["media/x", false],
    ["og-render", false],
    ["og-render-agent/x", false],
    ["sitemap.xml", false],
    ["llms.txt", false],
    ["robots.txt", false],
  ])("%j is CMS-servable: %s", (slug, servable) => {
    expect(isCmsServable(slug)).toBe(servable);
  });
});
