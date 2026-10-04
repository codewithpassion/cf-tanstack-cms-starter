// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; the regexes are not on a hot path.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim; each assertion follows a length or membership check.
/**
 * Pixel widths of search-result text. Google cuts titles and
 * descriptions by rendered width, not characters: titles are Arial 20px in a ~580px column,
 * descriptions Arial 14px over two ~460px lines (~920px). The editor measures with a canvas
 * (`canvasMeasure`); tests and the server use Arial's advance widths below (Arial is
 * metric-compatible with Helvetica, whose AFM widths these are), so checks stay deterministic.
 */

export const TITLE_FONT_PX = 20;
export const DESCRIPTION_FONT_PX = 14;
export const TITLE_MAX_PX = 580;
export const DESCRIPTION_MAX_PX = 920;
export const ELLIPSIS = "…";

/** Width of `text` in px at `fontPx` (Arial, regular). */
export type TextMeasure = (text: string, fontPx: number) => number;

/** Advance widths (1/1000 em) for ASCII 32–126. */
// prettier-ignore
const ASCII_WIDTHS = [
  278,
  278,
  355,
  556,
  556,
  889,
  667,
  191,
  333,
  333,
  389,
  584,
  278,
  333,
  278,
  278, // space ! " # $ % & ' ( ) * + , - . /
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  278,
  278,
  584,
  584,
  584,
  556, // 0-9 : ; < = > ?
  1015,
  667,
  667,
  722,
  722,
  667,
  611,
  778,
  722,
  278,
  500,
  667,
  556,
  833,
  722,
  778, // @ A-O
  667,
  778,
  722,
  667,
  611,
  722,
  667,
  944,
  667,
  667,
  611,
  278,
  278,
  278,
  469,
  556, // P-Z [ \ ] ^ _
  333,
  556,
  556,
  500,
  556,
  556,
  278,
  556,
  556,
  222,
  222,
  500,
  222,
  833,
  556,
  556, // ` a-o
  556,
  556,
  333,
  500,
  278,
  556,
  500,
  722,
  500,
  500,
  500,
  334,
  260,
  334,
  584, // p-z { | } ~
];

const OTHER_WIDTHS: Record<string, number> = {
  "…": 1000,
  "—": 1000,
  "–": 556,
  "‘": 222,
  "’": 222,
  "“": 333,
  "”": 333,
  "•": 350,
  "·": 278,
  "×": 584,
  "™": 1000,
  "©": 737,
  "®": 737,
  " ": 278,
};

/** Characters we have no width for (accented letters, other scripts) count as a digit's width. */
const DEFAULT_WIDTH = 556;

function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code >= 32 && code <= 126) {
    return ASCII_WIDTHS[code - 32]!;
  }
  return OTHER_WIDTHS[ch] ?? DEFAULT_WIDTH;
}

/** The deterministic measure: Arial advance widths, no kerning. */
export const arialMeasure: TextMeasure = (text, fontPx) => {
  let units = 0;
  for (const ch of text) {
    units += charWidth(ch);
  }
  return (units * fontPx) / 1000;
};

/**
 * A canvas-backed measure (browser only), falling back to `arialMeasure` when there is no canvas.
 * Uses Arial like Google's result page.
 */
export function canvasMeasure(): TextMeasure {
  if (typeof document === "undefined") {
    return arialMeasure;
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) {
    return arialMeasure;
  }
  return (text, fontPx) => {
    ctx.font = `${fontPx}px Arial, sans-serif`;
    return ctx.measureText(text).width;
  };
}

/**
 * `text` cut to fit `maxPx` with an ellipsis, as Google shows it: whole text when it fits, else
 * the longest prefix (trimmed back to a word boundary when one is near) that fits with "…".
 */
export function truncateToWidth(
  text: string,
  maxPx: number,
  fontPx: number,
  measure: TextMeasure = arialMeasure
): { text: string; truncated: boolean; width: number } {
  const width = measure(text, fontPx);
  if (width <= maxPx) {
    return { text, truncated: false, width };
  }
  const chars = [...text];
  const room = maxPx - measure(` ${ELLIPSIS}`, fontPx);
  // Binary search for the longest prefix that fits in front of the ellipsis.
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join(""), fontPx) <= room) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let cut = chars.slice(0, lo).join("");
  // Google breaks at a word when the last space is close; otherwise mid-word.
  const space = cut.lastIndexOf(" ");
  if (space > 0 && cut.length - space <= 15) {
    cut = cut.slice(0, space);
  }
  cut = cut.replace(/[\s,;:.\-–—|]+$/u, "");
  return {
    text: `${cut} ${ELLIPSIS}`.replace(/^ /, ""),
    truncated: true,
    width,
  };
}
