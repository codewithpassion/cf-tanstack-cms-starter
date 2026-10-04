import { describe, expect, it } from "bun:test";

import { blockStyleSchema } from "./schema";
import { colorValue } from "./vars";

describe("colour validation", () => {
  const valid = ["#fff", "#FFFF", "#ff6633", "#ff663380"];
  const invalid = [
    "#ff",
    "#ff663",
    "#fffff",
    "red",
    "#ggg",
    "#fff;position:fixed",
    "url(x)",
    " #fff",
  ];

  it.each(valid)("accepts %s", (hex) => {
    expect(
      blockStyleSchema.safeParse({ colors: { text: { hex } } }).success
    ).toBe(true);
    expect(colorValue({ hex })).toBe(hex);
  });

  it.each(invalid)("rejects %s", (hex) => {
    expect(
      blockStyleSchema.safeParse({ colors: { text: { hex } } }).success
    ).toBe(false);
    expect(colorValue({ hex })).toBeUndefined();
  });

  it("maps tokens to theme vars and rejects unknown tokens", () => {
    expect(colorValue({ token: "danger" })).toBe("var(--color-danger)");
    expect(
      blockStyleSchema.safeParse({ colors: { text: { token: "pink" } } })
        .success
    ).toBe(false);
    expect(colorValue({ token: "pink" } as never)).toBeUndefined();
  });
});
