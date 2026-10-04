import { describe, expect, it } from "bun:test";

import { resolvePath, slugToPath } from "./paths";

describe("resolvePath", () => {
  it.each([
    ["/", ""],
    ["/cms-test", "cms-test"],
    ["/services/automation-sprint", "services/automation-sprint"],
  ])("%s → slug %j", (path, slug) => {
    expect(resolvePath(path)).toEqual({ slug });
    expect(slugToPath(slug)).toBe(path);
  });

  it.each([
    ["/CMS-Test", "/cms-test"],
    ["/cms-test/", "/cms-test"],
    ["/Services/Sample//", "/services/sample"],
  ])("%s redirects to %s", (path, redirect) => {
    expect(resolvePath(path)).toEqual({ redirect });
  });

  it.each([
    "",
    "cms-test",
    "/../etc",
    "/a/../b",
    "/a//b",
    "/a_b",
    "/a%20b",
    "/-a",
    "/a.html",
  ])("%j is not a page path", (path) => {
    expect(resolvePath(path)).toBeNull();
  });
});
