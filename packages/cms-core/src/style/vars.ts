import { mediaUrl } from "../media";
import {
  type Align,
  type BlockStyle,
  BRAND_TOKENS,
  type Color,
  type Device,
  type ElementStyle,
  type GradientPreset,
  type MaxWidth,
  type Responsive,
  type TextSize,
  type Visibility,
} from "../types";
import { HEX_RE } from "./schema";

/**
 * Turns a BlockStyle into inline custom properties + data attributes read by ./cms.css.
 * Var names: --cms-<prop>-<d|t|m> on the block wrapper, --cms-e-<prop>-<d|t|m> on elements.
 */

export const DEVICES: readonly Device[] = ["desktop", "tablet", "mobile"];
const SUFFIX: Record<Device, string> = {
  desktop: "d",
  tablet: "t",
  mobile: "m",
};

export const MAX_WIDTHS: Record<MaxWidth, string> = {
  narrow: "896px", // max-w-4xl
  default: "1280px", // max-w-7xl
  wide: "1536px",
  full: "none",
};

export const TEXT_SIZES: Record<TextSize, string> = {
  sm: "0.875rem",
  base: "1rem",
  lg: "1.5rem",
  xl: "2.25rem",
  "2xl": "3.75rem",
};

const GRADIENTS: Record<GradientPreset, string> = {
  none: "none",
  dark: "linear-gradient(to bottom, color-mix(in srgb, var(--color-ink-soft) 30%, transparent), var(--color-ink))",
  "primary-glow":
    "linear-gradient(to top right, color-mix(in srgb, var(--color-primary) 10%, transparent), transparent)",
  "accent-glow":
    "linear-gradient(to top right, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent)",
  // The presets below match Tailwind's `bg-gradient-to-*` output (oklab).
  // The reverse of `dark`.
  "ink-rise":
    "linear-gradient(to bottom in oklab, var(--color-ink), color-mix(in oklab, var(--color-ink-soft) 30%, transparent))",
  // A faint accent wash from the left edge.
  "accent-edge":
    "linear-gradient(to right in oklab, color-mix(in oklab, var(--color-accent) 5%, transparent), transparent)",
  // Accent on the left, primary on the right.
  "accent-primary":
    "linear-gradient(to right in oklab, color-mix(in oklab, var(--color-accent) 5%, transparent), transparent, color-mix(in oklab, var(--color-primary) 5%, transparent))",
};

const MARGINS: Record<Align, [left: string, right: string]> = {
  left: ["0px", "auto"],
  center: ["auto", "auto"],
  right: ["auto", "0px"],
};

/** Only `--cms-*` custom properties are set (no React `CSSProperties` here); web spreads it into `style`. */
export type CmsVars = Record<`--cms-${string}`, string>;
export type CmsStyleProps = {
  style: CmsVars;
  attrs: Record<`data-cms-${string}`, string>;
};

/** Token → `var(--color-<token>)`; hex is re-checked because it lands in an inline style. */
export function colorValue(color: Color | undefined): string | undefined {
  if (!color) {
    return;
  }
  if ("token" in color) {
    return BRAND_TOKENS.includes(color.token)
      ? `var(--color-${color.token})`
      : undefined;
  }
  return HEX_RE.test(color.hex) ? color.hex : undefined;
}

// --- merge: per property, the block's own values win outright over the definition's default ---

type Obj = Record<string, unknown>;

const definesAny = (r: Partial<Record<Device, unknown>> | undefined) =>
  DEVICES.some((d) => r?.[d] !== undefined);

function mergeObj<T extends object>(
  base: T | undefined,
  over: T | undefined
): T | undefined {
  if (!base) {
    return over;
  }
  if (!over) {
    return base;
  }
  const out: Obj = { ...(base as Obj) };
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Webflow model: a property set on any device in the block's style is resolved from the block's
 * values only (desktop → tablet → mobile); the default applies only when the property is unset
 * everywhere. Also used for `hide`, where an explicit `false` counts as set.
 */
function pickResponsive<R extends Partial<Record<Device, unknown>>>(
  base: R | undefined,
  over: R | undefined
): R | undefined {
  return definesAny(over) ? over : base;
}

/** As pickResponsive, per sub-key: `padding.top` and `padding.bottom` are separate properties. */
function pickResponsiveObj<T extends Obj>(
  base: Responsive<T> | undefined,
  over: Responsive<T> | undefined
): Responsive<T> | undefined {
  if (!base) {
    return over;
  }
  if (!over) {
    return base;
  }
  const keys = new Set(
    DEVICES.flatMap((d) => [
      ...Object.keys(base[d] ?? {}),
      ...Object.keys(over[d] ?? {}),
    ])
  );
  const out: Partial<Record<Device, Obj>> = {};
  for (const key of keys) {
    const src = DEVICES.some((d) => over[d]?.[key] !== undefined) ? over : base;
    for (const d of DEVICES) {
      const v = src[d]?.[key];
      if (v !== undefined) {
        const tier = out[d] ?? {};
        tier[key] = v;
        out[d] = tier;
      }
    }
  }
  return out as Responsive<T>;
}

function mergeElement(
  base: ElementStyle | undefined,
  over: ElementStyle | undefined
): ElementStyle | undefined {
  if (!base) {
    return over;
  }
  if (!over) {
    return base;
  }
  return {
    color: over.color ?? base.color,
    size: pickResponsive(base.size, over.size),
    align: pickResponsive(base.align, over.align),
    hide: pickResponsive(base.hide, over.hide),
  };
}

/** The block definition's `base` style under the document's `over` style, chosen per property (see pickResponsive). */
export function mergeStyle(
  base: BlockStyle | undefined,
  over: BlockStyle | undefined
): BlockStyle {
  if (!base) {
    return over ?? {};
  }
  if (!over) {
    return base;
  }
  const names = new Set([
    ...Object.keys(base.elements ?? {}),
    ...Object.keys(over.elements ?? {}),
  ]);
  const elements: Record<string, ElementStyle> = {};
  for (const name of names) {
    const el = mergeElement(base.elements?.[name], over.elements?.[name]);
    if (el) {
      elements[name] = el;
    }
  }
  return {
    hide: pickResponsive(base.hide, over.hide),
    padding: pickResponsiveObj(base.padding, over.padding),
    margin: pickResponsiveObj(base.margin, over.margin),
    gap: pickResponsive(base.gap, over.gap),
    maxWidth: pickResponsive(base.maxWidth, over.maxWidth),
    align: pickResponsive(base.align, over.align),
    background: mergeObj(base.background, over.background),
    colors: mergeObj(base.colors, over.colors),
    border: over.border ?? base.border,
    elements: names.size ? elements : undefined,
  };
}

/** Effective value per device after inheritance (desktop → tablet → mobile). Unset devices are omitted. */
export function resolveResponsive<T>(
  value: Responsive<T> | undefined
): Responsive<T> {
  const out: Responsive<T> = {};
  let current: T | undefined;
  for (const d of DEVICES) {
    current = value?.[d] ?? current;
    if (current !== undefined) {
      out[d] = current;
    }
  }
  return out;
}

/** Hide cascades like any responsive value: `{desktop: true}` hides everywhere, `mobile: false` un-hides mobile. */
export function hiddenOn(hide: Visibility | undefined): Device[] {
  const resolved = resolveResponsive(hide);
  return DEVICES.filter((d) => resolved[d] === true);
}

// --- emit ---

function emit<T>(
  vars: Record<string, string>,
  name: string,
  value: Responsive<T> | undefined,
  format: (v: T) => string | undefined
) {
  for (const d of DEVICES) {
    const v = value?.[d];
    const out = v === undefined ? undefined : format(v);
    if (out !== undefined) {
      vars[`--cms-${name}-${SUFFIX[d]}`] = out;
    }
  }
}

const px = (n: number | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? `${n}px` : undefined;

function hideAttrs(
  attrs: Record<string, string>,
  hide: Visibility | undefined
) {
  for (const d of hiddenOn(hide)) {
    attrs[`data-cms-hide-${SUFFIX[d]}`] = "";
  }
}

/** Vars and attrs for a block wrapper. `defaultStyle` is the block definition's, `userStyle` the document's. */
export function computeStyleVars(
  defaultStyle: BlockStyle | undefined,
  userStyle: BlockStyle | undefined
): CmsStyleProps {
  const s = mergeStyle(defaultStyle, userStyle);
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};

  emit(vars, "pt", s.padding, (p) => px(p.top));
  emit(vars, "pb", s.padding, (p) => px(p.bottom));
  emit(vars, "px", s.padding, (p) => px(p.x));
  emit(vars, "mt", s.margin, (m) => px(m.top));
  emit(vars, "mb", s.margin, (m) => px(m.bottom));
  emit(vars, "gap", s.gap, px);
  emit(vars, "mw", s.maxWidth, (w) => MAX_WIDTHS[w]);
  emit(vars, "ta", s.align, (a) => (MARGINS[a] ? a : undefined));
  emit(vars, "ml", s.align, (a) => MARGINS[a]?.[0]);
  emit(vars, "mr", s.align, (a) => MARGINS[a]?.[1]);

  const bg = s.background;
  const bgColor = colorValue(bg?.color);
  if (bgColor) {
    vars["--cms-bg"] = bgColor;
  }
  if (bg?.gradient && GRADIENTS[bg.gradient]) {
    vars["--cms-bg-gradient"] = GRADIENTS[bg.gradient];
  }
  if (bg?.image) {
    const layers = [`url("${mediaUrl(bg.image.mediaId)}")`];
    const overlay = colorValue(bg.image.overlay);
    if (overlay) {
      // `opacity` is the overlay's strength over the image (0-1), default 0.6.
      const pct = Math.round(
        Math.min(1, Math.max(0, bg.image.opacity ?? 0.6)) * 100
      );
      const tint = `color-mix(in srgb, ${overlay} ${pct}%, transparent)`;
      layers.unshift(`linear-gradient(${tint}, ${tint})`);
    }
    vars["--cms-bg-image"] = layers.join(", ");
    attrs["data-cms-bg-image"] = "";
  }

  for (const key of ["text", "heading", "accent"] as const) {
    const c = colorValue(s.colors?.[key]);
    if (c) {
      vars[`--cms-${key}`] = c;
    }
  }

  if (s.border === "cyber" || s.border === "subtle") {
    attrs["data-cms-border"] = s.border;
  }
  hideAttrs(attrs, s.hide);

  return { style: vars as CmsVars, attrs };
}

/**
 * Vars and attrs for a styleable element. Responsive values are written resolved for every device
 * they reach, with a per-device marker attribute, so an unset device keeps the component's classes.
 */
export function computeElementVars(
  el: ElementStyle | undefined
): CmsStyleProps {
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  if (!el) {
    return { style: vars as CmsVars, attrs };
  }

  const color = colorValue(el.color);
  if (color) {
    vars.color = color;
  }

  const responsiveProps = [
    ["fs", el.size, (v: TextSize) => TEXT_SIZES[v]],
    ["ta", el.align, (v: Align) => (MARGINS[v] ? v : undefined)],
  ] as const;
  for (const [name, value, format] of responsiveProps) {
    const resolved = resolveResponsive<string>(value);
    const marked: string[] = [];
    for (const d of DEVICES) {
      const v =
        resolved[d] === undefined
          ? undefined
          : (format as (v: string) => string | undefined)(resolved[d]);
      if (v === undefined) {
        continue;
      }
      vars[`--cms-e-${name}-${SUFFIX[d]}`] = v;
      marked.push(SUFFIX[d]);
    }
    if (marked.length) {
      attrs[`data-cms-${name}`] = marked.join(" ");
    }
  }

  hideAttrs(attrs, el.hide);
  return { style: vars as CmsVars, attrs };
}
