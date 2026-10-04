// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noParameterAssign: ported verbatim; kept as in the source.
// biome-ignore-all lint/style/useDefaultSwitchClause: exhaustive switch over a union, as in the source.
import { mergePatch } from "../ops/json";
import { HEX_RE } from "../style/schema";
import { DEVICES, TEXT_SIZES } from "../style/vars";
import type {
  Block,
  BlockStyle,
  BrandToken,
  Color,
  Device,
  MergePatch,
  Op,
  Responsive,
  TextSize,
} from "../types";
import { parseBlock } from "../validate";

/**
 * Pure logic behind the Style panel: what value each style property has on
 * a device and where it comes from, the merge-patches that set or reset it, 4px spacing steps,
 * validation, and WCAG contrast. Mirrors the renderer (style/vars.ts mergeStyle + cms.css):
 *
 * - Once the block's own style sets a responsive property on any device, only the block's values
 *   count (desktop → tablet → mobile); the block definition's default applies only when the
 *   property is unset on every device. Padding and margin decide this per side.
 * - When the chain reaches nothing (e.g. only mobile is set and you look at desktop), the page gets
 *   cms.css's literal fallback, not the block default: that's the "base" source.
 */

export const DEVICE_LABEL: Record<Device, string> = {
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
};

/**
 * Where a property's value on the current device comes from:
 * - `here`: set on this device (dot + Reset);
 * - `inherited`: set on a larger device (`from`);
 * - `default`: the block definition's default style (the property is unset on every device);
 * - `base`: nothing reaches this device; the stylesheet's literal or the component's own look.
 */
export type Source =
  | { kind: "here" }
  | { kind: "inherited"; from: Device }
  | { kind: "default"; from?: Device }
  | { kind: "base" };

export type Effective<T> = { value: T | undefined; source: Source };

// --- property paths ------------------------------------------------------------------------------

/** Responsive properties: a value per device. */
export type ResponsivePath =
  | "padding.top"
  | "padding.bottom"
  | "padding.x"
  | "margin.top"
  | "margin.bottom"
  | "gap"
  | "maxWidth"
  | "align"
  | "hide"
  | `elements.${string}.${"size" | "align" | "hide"}`;

/** Properties that apply on every device. */
export type FlatPath =
  | "background.color"
  | "background.gradient"
  | "background.image"
  | "background.image.overlay"
  | "background.image.opacity"
  | "colors.text"
  | "colors.heading"
  | "colors.accent"
  | "border"
  | `elements.${string}.color`;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function getIn(value: unknown, path: readonly string[]): unknown {
  let cur = value;
  for (const k of path) {
    if (!isObj(cur)) {
      return;
    }
    cur = cur[k];
  }
  return cur;
}

/** `["padding", "mobile", "top"]` for ("padding.top", "mobile"); `["elements", "heading", "size", "mobile"]` for an element. */
function storagePath(path: ResponsivePath, device: Device): string[] {
  const parts = path.split(".");
  if (parts[0] === "padding" || parts[0] === "margin") {
    return [parts[0], device, parts[1]!];
  }
  return [...parts, device];
}

/** The per-device values of a responsive property, e.g. padding.top → { desktop: 96, mobile: 48 }. */
export function readResponsive(
  style: BlockStyle | undefined,
  path: ResponsivePath
): Responsive<unknown> {
  const out: Responsive<unknown> = {};
  for (const d of DEVICES) {
    const v = getIn(style, storagePath(path, d));
    if (v !== undefined) {
      out[d] = v;
    }
  }
  return out;
}

const definesAny = (r: Responsive<unknown>) =>
  DEVICES.some((d) => r[d] !== undefined);

/** The value on `device` and its source, given the block's own style and the definition's default style. */
export function effectiveResponsive<T = unknown>(
  own: BlockStyle | undefined,
  defaults: BlockStyle | undefined,
  path: ResponsivePath,
  device: Device
): Effective<T> {
  const mine = readResponsive(own, path);
  const fromOwn = definesAny(mine);
  const chain = fromOwn ? mine : readResponsive(defaults, path);
  let found: Device | undefined;
  for (const d of DEVICES.slice(0, DEVICES.indexOf(device) + 1)) {
    if (chain[d] !== undefined) {
      found = d;
    }
  }
  if (!found) {
    return { value: undefined, source: { kind: "base" } };
  }
  const value = chain[found] as T;
  if (!fromOwn) {
    return { value, source: { kind: "default", from: found } };
  }
  return {
    value,
    source:
      found === device ? { kind: "here" } : { kind: "inherited", from: found },
  };
}

/** As effectiveResponsive, for a property that isn't per device. */
export function effectiveFlat<T = unknown>(
  own: BlockStyle | undefined,
  defaults: BlockStyle | undefined,
  path: FlatPath
): Effective<T> {
  const parts = path.split(".");
  const mine = getIn(own, parts);
  if (mine !== undefined) {
    return { value: mine as T, source: { kind: "here" } };
  }
  const def = getIn(defaults, parts);
  if (def !== undefined) {
    return { value: def as T, source: { kind: "default" } };
  }
  return { value: undefined, source: { kind: "base" } };
}

/** cms.css literals: what a block gets when nothing reaches the device. Undefined = the component's own look. */
export function baseValue(path: ResponsivePath, device: Device): unknown {
  switch (path) {
    case "padding.top":
    case "padding.bottom":
    case "margin.top":
    case "margin.bottom":
      return 0;
    case "padding.x":
      return { desktop: 32, tablet: 24, mobile: 16 }[device];
    case "gap":
      return 24;
    case "maxWidth":
      return "default";
    case "align":
      return "left";
    case "hide":
      return false;
    default:
      return path.endsWith(".hide") ? false : undefined;
  }
}

/** Effective value with the base literal filled in. */
export function displayValue<T>(
  eff: Effective<T>,
  path: ResponsivePath,
  device: Device
): T | undefined {
  return eff.value === undefined
    ? (baseValue(path, device) as T | undefined)
    : eff.value;
}

export function sourceLabel(source: Source): string {
  switch (source.kind) {
    case "here":
      return "Set here";
    case "inherited":
      return `Inherited from ${DEVICE_LABEL[source.from]}`;
    case "default":
      return "Block default";
    case "base":
      return "Not set";
  }
}

// --- patches -------------------------------------------------------------------------------------

/** Nested merge-patch `{a: {b: value}}` for path [a, b]. */
function patchAt(path: readonly string[], value: unknown): Obj {
  let out: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) {
    out = { [path[i]!]: out };
  }
  return out as Obj;
}

export type StylePatch = MergePatch<BlockStyle>;

export function setResponsivePatch(
  path: ResponsivePath,
  device: Device,
  value: unknown
): StylePatch {
  return patchAt(storagePath(path, device), value) as StylePatch;
}

export function setFlatPatch(path: FlatPath, value: unknown): StylePatch {
  return patchAt(
    path.split("."),
    value === undefined ? null : value
  ) as StylePatch;
}

/**
 * Sets a colour. A merge patch would merge `{hex}` into a stored `{token}` (an invalid colour with
 * both keys), so the other kind is deleted explicitly.
 */
export function setColorPatch(path: FlatPath, color: Color): StylePatch {
  return setFlatPatch(
    path,
    "token" in color
      ? { token: color.token, hex: null }
      : { hex: color.hex, token: null }
  );
}

/**
 * Deletes the value at `path` (merge-patch `null`), and with it every ancestor that would be left
 * empty, so a reset leaves no `{ mobile: {} }` behind. Null when there's nothing to delete.
 */
function deletePatch(
  style: BlockStyle | undefined,
  path: readonly string[]
): StylePatch | null {
  if (getIn(style, path) === undefined) {
    return null;
  }
  let cut = path.length;
  while (cut > 1) {
    const parent = getIn(style, path.slice(0, cut - 1));
    const others = isObj(parent)
      ? Object.keys(parent).filter(
          (k) => k !== path[cut - 1] && parent[k] !== undefined
        )
      : [];
    if (others.length) {
      break;
    }
    cut--;
  }
  return patchAt(path.slice(0, cut), null) as StylePatch;
}

/** Reset on `device`: the device inherits from the next larger one again (or the block default / base). */
export function resetResponsivePatch(
  style: BlockStyle | undefined,
  path: ResponsivePath,
  device: Device
): StylePatch | null {
  return deletePatch(style, storagePath(path, device));
}

export function resetFlatPatch(
  style: BlockStyle | undefined,
  path: FlatPath
): StylePatch | null {
  return deletePatch(style, path.split("."));
}

export const styleOp = (key: string, style: StylePatch): Op => ({
  op: "update",
  key,
  style,
});

/** The block's style after `patch` (undefined when nothing is left, as applyOps stores it). */
export function patchedStyle(
  style: BlockStyle | undefined,
  patch: StylePatch
): BlockStyle | undefined {
  const next = mergePatch(style, patch) as BlockStyle;
  return Object.keys(next).length ? next : undefined;
}

/**
 * Checks the block with `patch` applied, as the store's `validateBlock` will (style schema, element
 * names and the properties each element supports). Returns the first style error, or null.
 */
export function validateStylePatch(
  block: Block,
  patch: StylePatch
): string | null {
  const style = patchedStyle(block.style, patch);
  const { errors } = parseBlock({ ...block, style });
  const error =
    errors.find((e) => e.path === "style" || e.path.startsWith("style.")) ??
    errors[0];
  if (!error) {
    return null;
  }
  return friendlyStyleError(error.path, error.message);
}

const RANGE_RE = /^Too (small|big): expected number to be ([<>]=?)(-?\d+)/;

function friendlyStyleError(path: string, message: string): string {
  const range = RANGE_RE.exec(message);
  if (range) {
    return range[1] === "small"
      ? `Use ${range[3]} or more`
      : `Use ${range[3]} or less`;
  }
  if (/expected int/.test(message)) {
    return "Use a whole number";
  }
  return path ? `${path.replace(/^style\./, "")}: ${message}` : message;
}

// --- spacing -------------------------------------------------------------------------------------

export const GRID = 4;

/** Allowed ranges, as in style/schema.ts. */
export const SPACING_RANGE: Record<
  | "padding.top"
  | "padding.bottom"
  | "padding.x"
  | "margin.top"
  | "margin.bottom"
  | "gap",
  [number, number]
> = {
  "padding.top": [0, 512],
  "padding.bottom": [0, 512],
  "padding.x": [0, 256],
  "margin.top": [-256, 512],
  "margin.bottom": [-256, 512],
  gap: [0, 256],
};

export const snap = (n: number) => Math.round(n / GRID) * GRID;
/** The next grid line above `n` (an off-grid 30 steps to 32, not 34). */
export const stepUp = (n: number) => Math.floor(n / GRID) * GRID + GRID;
/** The next grid line below `n`. */
export const stepDown = (n: number) => Math.ceil(n / GRID) * GRID - GRID;

const clamp = (n: number, [min, max]: [number, number]) =>
  Math.min(max, Math.max(min, n));

/** A canvas drag: start value plus the pointer's travel, snapped to the 4px grid and kept in range. */
export function dragValue(
  start: number,
  delta: number,
  range: [number, number] = SPACING_RANGE["padding.top"]
): number {
  return clamp(snap(start + delta), range);
}

/**
 * A padding handle's value after an arrow key: Up/Right add 4px (to the next grid line), Down/Left
 * take 4px off, Shift makes it 16px; clamped to the padding range. Null for any other key.
 */
export function keyStepValue(
  current: number,
  key: string,
  shift: boolean,
  range: [number, number] = SPACING_RANGE["padding.top"]
): number | null {
  const up = key === "ArrowUp" || key === "ArrowRight";
  if (!up && key !== "ArrowDown" && key !== "ArrowLeft") {
    return null;
  }
  if (shift) {
    return dragValue(current, up ? 16 : -16, range);
  }
  return clamp(up ? stepUp(current) : stepDown(current), range);
}

/** The single op a padding drag commits on release, or null when the value didn't change. */
export function paddingDragOp(
  block: Block,
  defaults: BlockStyle | undefined,
  device: Device,
  edge: "top" | "bottom",
  value: number
): Op | null {
  const path = `padding.${edge}` as const;
  const eff = effectiveResponsive<number>(block.style, defaults, path, device);
  if (eff.source.kind === "here" && eff.value === value) {
    return null;
  }
  return styleOp(block._key, setResponsivePatch(path, device, value));
}

// --- colour and contrast -------------------------------------------------------------------------

/**
 * The brand tokens' values as sRGB hex, for contrast ratings. They must match the theme tokens in
 * apps/web/src/styles.css (`@theme static`, `--color-brand-*`); parseCssColor reads hex and hsl only, so the hex is kept here
 * (the web app's theme-tokens test checks the two agree). Change both together.
 */
export const TOKEN_CSS: Record<BrandToken, string> = {
  primary: "#4f46e5",
  "primary-soft": "#818cf8",
  ink: "#09090b",
  danger: "#dc2626",
  accent: "#0284c7",
  "ink-soft": "#3f3f46",
  muted: "#71717a",
  white: "#fff",
};

export type Rgba = { r: number; g: number; b: number; a: number };

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `hsl(h, s%, l%)`. */
export function parseCssColor(css: string): Rgba | null {
  const value = css.trim();
  if (HEX_RE.test(value)) {
    let hex = value.slice(1);
    if (hex.length <= 4) {
      hex = [...hex].map((c) => c + c).join("");
    }
    const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(
    value
  );
  if (hsl) {
    const [r, g, b] = hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
    return { r, g, b, a: 1 };
  }
  return null;
}

export function colorRgba(color: Color | undefined): Rgba | null {
  if (!color) {
    return null;
  }
  return "token" in color
    ? TOKEN_CSS[color.token]
      ? parseCssColor(TOKEN_CSS[color.token])
      : null
    : parseCssColor(color.hex);
}

/** WCAG 2 relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.039_28 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** AA: 4.5:1 for body text, 3:1 for large text (≥24px, or ≥18.66px bold). */
export const AA_BODY = 4.5;
export const AA_LARGE = 3;

export type ContrastRating =
  | { kind: "unknown"; reason: string }
  | { kind: "rated"; ratio: number; threshold: number; pass: boolean };

/** The block's solid background colour, or why there isn't one we can rate against. */
export function solidBackground(
  merged: BlockStyle
): { color: Color } | { reason: string } {
  const bg = merged.background;
  if (bg?.image) {
    return { reason: "Background image" };
  }
  if (bg?.gradient && bg.gradient !== "none") {
    return { reason: "Gradient background (set Gradient to None to rate)" };
  }
  if (!bg?.color) {
    return { reason: "No background colour set" };
  }
  const rgba = colorRgba(bg.color);
  if (!rgba) {
    return { reason: "Unrecognised background colour" };
  }
  if (rgba.a < 1) {
    return { reason: "Translucent background" };
  }
  return { color: bg.color };
}

/**
 * Rates `fg` on the block background; only solid colour-on-colour pairs get a number. `large`:
 * the text is known to be large (else it's rated as body text, 4.5:1). `onCard`: (some of) the
 * text sits on a translucent card, not on the block background, so it can't be rated.
 */
export function rateContrast(
  fg: Color | undefined,
  merged: BlockStyle,
  large: boolean,
  onCard = false
): ContrastRating {
  if (!fg) {
    return { kind: "unknown", reason: "Uses the block's own colour" };
  }
  if (onCard) {
    return { kind: "unknown", reason: "Text on a translucent card" };
  }
  const bg = solidBackground(merged);
  if ("reason" in bg) {
    return { kind: "unknown", reason: bg.reason };
  }
  const f = colorRgba(fg);
  const b = colorRgba(bg.color);
  if (!(f && b)) {
    return { kind: "unknown", reason: "Unrecognised colour" };
  }
  if (f.a < 1) {
    return { kind: "unknown", reason: "Translucent text colour" };
  }
  const ratio = contrastRatio(f, b);
  const threshold = large ? AA_LARGE : AA_BODY;
  return { kind: "rated", ratio, threshold, pass: ratio >= threshold };
}

const SIZE_PX: Record<TextSize, number> = Object.fromEntries(
  Object.entries(TEXT_SIZES).map(([k, rem]) => [k, Number.parseFloat(rem) * 16])
) as Record<TextSize, number>;

/** Large text for WCAG when its size is known to be ≥24px; unknown sizes are rated as body text. */
export const isLargeSize = (size: TextSize | undefined) =>
  size !== undefined && SIZE_PX[size] >= 24;
