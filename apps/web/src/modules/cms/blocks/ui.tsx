import type { Button } from "@repo/cms-core/links";
import { Fragment, type ReactNode } from "react";

import type { FieldProps } from "../render/field";

/** What every block Component receives: its validated props (cms-core def schema output). */
export type BlockComponentProps<P> = { props: P };

/**
 * Shared visual idiom of the blocks: a small eyebrow label, heading font, solid and outline
 * buttons. Colours read the block's --cms-* vars (set when an editor picks a colour) and fall back
 * to the theme variables, so an unstyled block follows light and dark mode.
 */

export const textColor = "text-[color:var(--cms-text,var(--muted-foreground))]";
export const accentColor = "text-[color:var(--cms-accent,var(--primary))]";
export const headingColor = "text-[color:var(--cms-heading,var(--foreground))]";

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
      className={`text-[color:var(--cms-accent,var(--brand-label))] font-sans font-semibold ${size === "xs" ? "text-xs" : "text-sm"} ${spacing}`}
    >
      {children}
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
  return <div className="cms-measure w-12 h-1 rounded-full bg-primary mb-8" />;
}

const primaryClass =
  "inline-block rounded-md bg-primary text-primary-foreground font-medium px-5 py-2.5 shadow-soft transition-colors hover:bg-primary/90 active:bg-primary";
const secondaryClass =
  "inline-block rounded-md border border-border bg-background text-foreground font-medium px-5 py-2.5 shadow-soft transition-colors hover:bg-accent";

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
 * Large buttons (home hero, trust section, large CTA). The font
 * size is inherited, so an element `size` style applies. `secondary` is a primary outline,
 * `tertiary` an accent outline.
 */
const BIG_BUTTON = {
  primary: "bg-primary text-primary-foreground shadow-soft hover:bg-primary/90",
  secondary:
    "border border-border bg-background text-foreground shadow-soft hover:bg-accent",
  tertiary: "border border-primary text-primary hover:bg-primary/10",
} as const;

export function bigButtonClass(
  kind: keyof typeof BIG_BUTTON,
  size: "md" | "lg" = "md"
): string {
  const pad = size === "lg" ? "px-7 py-3.5 text-base" : "px-6 py-3";
  return `inline-block rounded-md font-medium ${pad} transition-colors ${BIG_BUTTON[kind]}`;
}
