import { describe, expect, it } from "bun:test";

import type { BlockStyle, ElementStyle } from "../types";
import { blockStyleSchema } from "./schema";
import {
  colorValue,
  computeElementVars,
  computeStyleVars,
  mergeStyle,
} from "./vars";

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

describe("computeStyleVars", () => {
  it("emits nothing when nothing is set", () => {
    expect(computeStyleVars(undefined, undefined)).toEqual({
      style: {},
      attrs: {},
    });
  });

  it("emits one var per device that is set, and maps width, align and gap", () => {
    const { style } = computeStyleVars(undefined, {
      padding: { desktop: { top: 64 }, mobile: { top: 32, x: 16 } },
      gap: { tablet: 24 },
      maxWidth: { desktop: "narrow" },
      align: { desktop: "center" },
    });
    expect(style).toEqual({
      "--cms-pt-d": "64px",
      "--cms-pt-m": "32px",
      "--cms-px-m": "16px",
      "--cms-gap-t": "24px",
      "--cms-mw-d": "896px",
      "--cms-ta-d": "center",
      "--cms-ml-d": "auto",
      "--cms-mr-d": "auto",
    });
  });

  it("writes colours, a border attribute and hide attributes that cascade down", () => {
    const { style, attrs } = computeStyleVars(undefined, {
      colors: { heading: { token: "accent" }, text: { hex: "#fff" } },
      border: "subtle",
      hide: { tablet: true },
    });
    expect(style).toEqual({
      "--cms-heading": "var(--color-accent)",
      "--cms-text": "#fff",
    });
    expect(attrs).toEqual({
      "data-cms-border": "subtle",
      "data-cms-hide-t": "",
      "data-cms-hide-m": "",
    });
  });

  it("per property, a user value on any device replaces the default's for that property only", () => {
    const defaults: BlockStyle = {
      padding: { desktop: { top: 128, bottom: 80 }, mobile: { top: 96 } },
    };
    const { style } = computeStyleVars(defaults, {
      padding: { desktop: { top: 200 } },
    });
    expect(style).toEqual({ "--cms-pt-d": "200px", "--cms-pb-d": "80px" });
    // Unset by the user everywhere: the default's own devices apply.
    expect(computeStyleVars(defaults, {}).style).toEqual({
      "--cms-pt-d": "128px",
      "--cms-pt-m": "96px",
      "--cms-pb-d": "80px",
    });
  });

  it("an explicit hide:false replaces the default's hide as a whole", () => {
    expect(
      computeStyleVars({ hide: { tablet: true } }, { hide: { mobile: false } })
        .attrs
    ).toEqual({});
    expect(computeStyleVars({ hide: { tablet: true } }, {}).attrs).toEqual({
      "data-cms-hide-t": "",
      "data-cms-hide-m": "",
    });
  });
});

describe("mergeStyle", () => {
  it("returns the other side when one is missing and merges element styles per property", () => {
    expect(mergeStyle(undefined, undefined)).toEqual({});
    const base: BlockStyle = { gap: { desktop: 8 } };
    expect(mergeStyle(base, undefined)).toBe(base);
    const merged = mergeStyle(
      {
        elements: {
          heading: { size: { desktop: "lg" }, align: { desktop: "left" } },
        },
      },
      { elements: { heading: { size: { mobile: "sm" } } } }
    );
    const heading: ElementStyle | undefined = merged.elements?.heading;
    expect(heading?.size).toEqual({ mobile: "sm" });
    expect(heading?.align).toEqual({ desktop: "left" });
  });
});

describe("computeElementVars", () => {
  it("leaves an element alone when nothing is set", () => {
    expect(computeElementVars(undefined)).toEqual({ style: {}, attrs: {} });
  });

  it("applies a mobile-only size on mobile only", () => {
    expect(computeElementVars({ size: { mobile: "sm" } })).toEqual({
      style: { "--cms-e-fs-m": "0.875rem" },
      attrs: { "data-cms-fs": "m" },
    });
  });

  it("inherits a desktop size down until a smaller device sets its own", () => {
    const { style, attrs } = computeElementVars({
      size: { desktop: "2xl", mobile: "lg" },
      align: { desktop: "center" },
    });
    expect(style).toEqual({
      "--cms-e-fs-d": "3.75rem",
      "--cms-e-fs-t": "3.75rem",
      "--cms-e-fs-m": "1.5rem",
      "--cms-e-ta-d": "center",
      "--cms-e-ta-t": "center",
      "--cms-e-ta-m": "center",
    });
    expect(attrs).toEqual({ "data-cms-fs": "d t m", "data-cms-ta": "d t m" });
  });

  it("writes colour inline and hide attrs", () => {
    const { style, attrs } = computeElementVars({
      color: { token: "danger" },
      hide: { desktop: true, tablet: false },
    });
    expect(Object.entries(style)).toEqual([["color", "var(--color-danger)"]]);
    expect(attrs).toEqual({ "data-cms-hide-d": "" });
  });
});
