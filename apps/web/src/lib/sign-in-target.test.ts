import { describe, expect, it } from "bun:test";

import { safeRedirectPath } from "./sign-in-target";

describe("safeRedirectPath", () => {
  it("keeps root-relative paths, with their query", () => {
    expect(safeRedirectPath("/admin/pages")).toBe("/admin/pages");
    expect(safeRedirectPath("/admin/pages?x=1#y")).toBe("/admin/pages?x=1#y");
  });

  it("rejects anything that could leave the site, and non-strings", () => {
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "evil.example",
      "javascript:alert(1)",
      "/admin\n",
      "",
      undefined,
      42,
    ]) {
      expect(safeRedirectPath(value)).toBeUndefined();
    }
  });
});
