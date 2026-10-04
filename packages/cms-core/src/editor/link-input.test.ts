import { describe, expect, it } from "bun:test";

import { linkAction, UNSAFE_LINK_MESSAGE } from "./link-input";

describe("linkAction", () => {
  it("removes the link when the input is empty or blank", () => {
    expect(linkAction("")).toEqual({ kind: "remove" });
    expect(linkAction("   ")).toEqual({ kind: "remove" });
  });

  it("sets relative, https, mailto and tel links, trimmed", () => {
    expect(linkAction(" /about ")).toEqual({ kind: "set", href: "/about" });
    expect(linkAction("#pricing")).toEqual({ kind: "set", href: "#pricing" });
    expect(linkAction("https://example.com")).toEqual({
      kind: "set",
      href: "https://example.com",
    });
    expect(linkAction("mailto:hi@example.com").kind).toBe("set");
    expect(linkAction("tel:+61200000000").kind).toBe("set");
  });

  it("refuses http and script links with the same message as before", () => {
    for (const bad of ["http://example.com", "javascript:alert(1)"]) {
      expect(linkAction(bad)).toEqual({
        kind: "invalid",
        message: UNSAFE_LINK_MESSAGE,
      });
    }
  });
});
