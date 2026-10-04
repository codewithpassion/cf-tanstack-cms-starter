import { describe, expect, it } from "bun:test";

import { googleBreadcrumb } from "./previews";

describe("googleBreadcrumb", () => {
  it("decodes path segments, and shows a malformed escape as typed instead of throwing", () => {
    expect(googleBreadcrumb("https://example.com/caf%C3%A9/x")).toBe(
      "https://example.com › café › x"
    );
    expect(googleBreadcrumb("https://example.com/%E0/x")).toBe(
      "https://example.com › %E0 › x"
    );
  });
});
