import { describe, expect, it } from "bun:test";

import { plainTitle } from "./thread-title";

describe("plainTitle", () => {
  it("shows a Markdown first message as one plain line", () => {
    expect(
      plainTitle(
        "Fix SEO on 2 pages: /a, /b\n\n## /a (“A”)\nCheck issues:\n- [warn] Title length: too long",
        200
      )
    ).toBe(
      "Fix SEO on 2 pages: /a, /b /a (“A”) Check issues: [warn] Title length: too long"
    );
    expect(
      plainTitle("Make the **CTA** stand out, see [the page](/x) and `code`")
    ).toBe("Make the CTA stand out, see the page and code");
    expect(plainTitle("Rewrite the hero for CFOs")).toBe(
      "Rewrite the hero for CFOs"
    );
    expect(plainTitle("x".repeat(100))).toHaveLength(80);
  });
});
