// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; the regexes are not on a hot path.
import { describe, expect, it } from "bun:test";

import {
  arialMeasure,
  DESCRIPTION_FONT_PX,
  DESCRIPTION_MAX_PX,
  ELLIPSIS,
  TITLE_FONT_PX,
  TITLE_MAX_PX,
  truncateToWidth,
} from "./pixel-width";

describe("arialMeasure", () => {
  it("uses Arial advance widths", () => {
    // "I" is 278, "W" 944 units per 1000 em.
    expect(arialMeasure("I", 20)).toBeCloseTo(5.56);
    expect(arialMeasure("W", 20)).toBeCloseTo(18.88);
    expect(arialMeasure("iiii", 10)).toBeCloseTo(8.88);
    expect(arialMeasure("", 20)).toBe(0);
  });

  it("measures wide letters wider than narrow ones of the same count", () => {
    expect(arialMeasure("WWWWWWWWWW", TITLE_FONT_PX)).toBeGreaterThan(
      arialMeasure("iiiiiiiiii", TITLE_FONT_PX) * 3
    );
  });

  it("gives unknown characters a digit's width", () => {
    expect(arialMeasure("é", 10)).toBeCloseTo(arialMeasure("0", 10));
  });
});

describe("truncateToWidth", () => {
  it("keeps text that fits", () => {
    const r = truncateToWidth(
      "AI transformation consulting",
      TITLE_MAX_PX,
      TITLE_FONT_PX
    );
    expect(r).toMatchObject({
      text: "AI transformation consulting",
      truncated: false,
    });
  });

  it("cuts at a word boundary and adds an ellipsis within the width", () => {
    const long =
      "Claude Code training for engineering teams in Sydney, Melbourne and Brisbane | Example Co";
    const r = truncateToWidth(long, TITLE_MAX_PX, TITLE_FONT_PX);
    expect(r.truncated).toBe(true);
    expect(r.width).toBeGreaterThan(TITLE_MAX_PX);
    expect(r.text.endsWith(` ${ELLIPSIS}`)).toBe(true);
    expect(arialMeasure(r.text, TITLE_FONT_PX)).toBeLessThanOrEqual(
      TITLE_MAX_PX
    );
    const kept = r.text.slice(0, -2);
    expect(long.startsWith(kept)).toBe(true);
    // The cut falls between words.
    expect(long[kept.length]).toMatch(/[\s,]/);
  });

  it("cuts mid-word when there's no space near the end", () => {
    const r = truncateToWidth("W".repeat(60), 200, TITLE_FONT_PX);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/^W+ …$/);
    expect(arialMeasure(r.text, TITLE_FONT_PX)).toBeLessThanOrEqual(200);
  });

  it("drops trailing punctuation before the ellipsis", () => {
    const r = truncateToWidth(
      "Short words, then a very long tail of filler words that goes on",
      300,
      DESCRIPTION_FONT_PX * 2
    );
    expect(r.text).not.toMatch(/[,;:.] …$/);
  });

  it("uses an injected measure (the canvas in the browser)", () => {
    const perChar = (text: string) => text.length * 10;
    const r = truncateToWidth(
      "abcdefghij klmnop",
      100,
      DESCRIPTION_FONT_PX,
      perChar
    );
    // 100px - 20px for " …" leaves 8 chars, with no space among them: a mid-word cut.
    expect(r.text).toBe("abcdefgh …");
    expect(
      truncateToWidth(
        "x".repeat(92),
        DESCRIPTION_MAX_PX,
        DESCRIPTION_FONT_PX,
        perChar
      ).truncated
    ).toBe(false);
  });
});
