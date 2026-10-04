import type { Button } from "@repo/cms-core/links";
import { Fragment, type ReactNode } from "react";

import type { FieldProps } from "../render/field";

/** What every block Component receives: its validated props (cms-core def schema output). */
export type BlockComponentProps<P> = { props: P };

/**
 * Shared visual idiom of the blocks: a "> Label" eyebrow, heading font, gradient divider bar,
 * gradient/outline buttons. Colours read the block's --cms-* vars with the theme tokens as the
 * fallback.
 */

export const textColor = "text-[color:var(--cms-text,rgb(255_255_255/0.8))]";
export const accentColor = "text-[color:var(--cms-accent,var(--color-accent))]";
export const headingPrimary =
  "text-[color:var(--cms-heading,var(--color-primary))]";
export const headingWhite =
  "text-[color:var(--cms-heading,var(--color-white))]";

/** `size`/`spacing`: section intros use `sm` + `mb-6`, denser sections `xs` + `mb-4`. */
export function Eyebrow({
  children,
  field,
  size = "sm",
  spacing = "mb-4",
}: {
  children: ReactNode;
  field: FieldProps;
  size?: "xs" | "sm";
  spacing?: "mb-4" | "mb-6";
}) {
  return (
    <div
      {...field}
      className={`${accentColor} font-sans ${size === "xs" ? "text-xs" : "text-sm"} tracking-widest uppercase ${spacing}`}
    >
      &gt; {children}
    </div>
  );
}

/** The field props without the editor's inline-edit marker (style vars and hide attributes stay). */
export function notInline(field: FieldProps): FieldProps {
  const { "data-cms-field": _marker, ...rest } = field;
  return rest;
}

/**
 * Only the element's per-device hide markers (`data-cms-hide-*`), for a container that exists just
 * to hold the element (a column, a box, the carousel dots): it collapses with the element instead
 * of staying behind empty. `data-cms-collapses` lets the editor keep it (and the faded element)
 * on the canvas when hidden elements are shown.
 */
export function hideOnly(
  field: FieldProps
): Record<`data-cms-${string}`, string> {
  const out: Record<`data-cms-${string}`, string> = {};
  for (const [key, value] of Object.entries(field)) {
    if (key.startsWith("data-cms-hide-") && typeof value === "string") {
      out[key as `data-cms-${string}`] = value;
    }
  }
  if (Object.keys(out).length) {
    out["data-cms-collapses"] = "";
  }
  return out;
}

/**
 * Props for an element whose text may contain an accent span: with the accent present, the
 * element isn't inline-editable (the canvas edits single-text elements only; editing would drop the
 * span), so its text is edited in the inspector, like the eyebrow's decorated text.
 */
export function accentedField(
  field: FieldProps,
  text: string,
  accent?: string
): FieldProps {
  return accent && text.includes(accent) ? notInline(field) : field;
}

/**
 * `text` with the first occurrence of `accent` wrapped in a span (coloured words in a heading,
 * e.g. "How We <Transform Teams>"). The span is the styleable element `field` (styled, not
 * inline-editable); its `color` (a class, e.g. `text-primary`) is the default an element colour
 * overrides. Nothing is added to the text. Give the enclosing element `accentedField(...)`.
 */
export function Accented({
  text,
  accent,
  field,
  color,
}: {
  text: string;
  accent?: string;
  field: FieldProps;
  color: string;
}) {
  const at = accent ? text.indexOf(accent) : -1;
  if (!accent || at < 0) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, at)}
      <span {...notInline(field)} className={color}>
        {accent}
      </span>
      {text.slice(at + accent.length)}
    </>
  );
}

/** Text with `\n` rendered as line breaks. */
export function Lines({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines of one string; their order never changes.
        <Fragment key={i}>
          {i > 0 && <br />}
          {line}
        </Fragment>
      ))}
    </>
  );
}

export function Divider() {
  return (
    <div className="cms-measure w-24 h-1 bg-gradient-to-r from-primary to-accent mb-8" />
  );
}

const primaryClass =
  "inline-block bg-gradient-to-r from-primary to-primary-soft text-black font-heading font-bold px-8 py-4 uppercase tracking-wider transition-all hover:scale-105 hover:shadow-lg hover:shadow-primary/50 active:scale-95";
const secondaryClass =
  "inline-block border border-accent text-accent font-heading font-bold px-8 py-4 uppercase tracking-wider transition-all hover:scale-105 hover:bg-accent/10 active:scale-95";

/** Buttons sit in an inline-flex row so they follow the block's text alignment. */
export function Buttons({
  primary,
  secondary,
  field,
  className,
}: {
  primary?: Button;
  secondary?: Button;
  field: FieldProps;
  className?: string;
}) {
  if (!(primary || secondary)) {
    return null;
  }
  return (
    <div {...field} className={className}>
      <div className="inline-flex flex-wrap gap-4">
        {!!primary && (
          <a href={primary.href} className={primaryClass}>
            {primary.label}
          </a>
        )}
        {!!secondary && (
          <a href={secondary.href} className={secondaryClass}>
            {secondary.label}
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Large buttons (home hero, trust section, large CTA): not uppercase, a scale on hover. The font
 * size is inherited, so an element `size` style applies. `secondary` is a primary outline,
 * `tertiary` an accent outline.
 */
const BIG_BUTTON = {
  primary:
    "bg-gradient-to-r from-primary to-primary-soft text-black hover:shadow-lg hover:shadow-primary/50",
  secondary:
    "border-2 border-primary text-primary hover:bg-primary hover:text-black",
  tertiary:
    "border-2 border-accent text-accent hover:bg-accent hover:text-black",
} as const;

export function bigButtonClass(
  kind: keyof typeof BIG_BUTTON,
  size: "md" | "lg" = "md"
): string {
  const pad = size === "lg" ? "px-12 py-6 text-lg" : "px-10 py-5";
  return `inline-block font-heading font-bold ${pad} transition-all hover:scale-105 active:scale-95 ${BIG_BUTTON[kind]}`;
}
