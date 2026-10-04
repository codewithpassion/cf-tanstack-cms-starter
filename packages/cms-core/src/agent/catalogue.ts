// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/style/useTemplate: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noExplicitAny: ported verbatim; walks Zod's internal schema shapes, which have no public types.
import type { z } from "zod";

import type { AnyBlockDef } from "../blocks/registry";
import { listBlockDefs } from "../blocks/registry";
import { TOKEN_CSS } from "../editor/style-model";
import { hrefSchema } from "../links";
import { mediaIdSchema } from "../media-schema";
import { type RichTextDoc, richTextSchema } from "../richtext/schema";
import { blockStyleSchema, colorSchema } from "../style/schema";
import { MAX_WIDTHS, TEXT_SIZES } from "../style/vars";
import { BRAND_TOKENS } from "../types";
import { fromMarkdown, toMarkdown } from "./markdown";

/**
 * The block and style catalogue the AI page agent works from,
 * generated from the block registry so it can never drift from what validation accepts. The text
 * goes into the cached system prompt: it must be deterministic (registry order, no dates).
 *
 * Rich-text props are Markdown on the agent's side: `propsForAgent` turns them into Markdown and
 * `propsFromAgent` back into the restricted TipTap JSON, guided by the schema (not by guessing
 * which strings look like Markdown).
 */

type AnyZod = z.ZodType & { _zod: { def: Record<string, any> } };

const def = (s: z.ZodType) => (s as AnyZod)._zod.def;

/** The document schema behind `richTextSchema` (its pipe's output), which blocks may also reach through refinements. */
const RICH_TEXT_DOC = def(richTextSchema).out as z.ZodType;
const isRichText = (s: z.ZodType) =>
  s === richTextSchema || s === RICH_TEXT_DOC;

/** Peels wrappers that don't change the value's shape for the agent. */
function unwrap(s: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let schema = s;
  let optional = false;
  for (;;) {
    if (isRichText(schema)) {
      return { schema: richTextSchema, optional };
    }
    const d = def(schema);
    if (
      d.type === "optional" ||
      d.type === "nullable" ||
      d.type === "default" ||
      d.type === "prefault"
    ) {
      if (d.type !== "nullable") {
        optional = true;
      }
      schema = d.innerType;
    } else if (d.type === "pipe") {
      schema = d.out;
    } else if (d.type === "lazy") {
      schema = d.getter();
    } else {
      return { schema, optional };
    }
  }
}

function lengthNote(s: z.ZodType): string {
  const d = def(s);
  let min: number | undefined;
  let max: number | undefined;
  for (const c of d.checks ?? []) {
    const cd = c._zod?.def as
      | { check?: string; minimum?: number; maximum?: number; value?: number }
      | undefined;
    if (cd?.check === "min_length") {
      min = cd.minimum;
    }
    if (cd?.check === "max_length") {
      max = cd.maximum;
    }
    if (cd?.check === "greater_than" && typeof cd.value === "number") {
      min = cd.value;
    }
    if (cd?.check === "less_than" && typeof cd.value === "number") {
      max = cd.value;
    }
  }
  if (min !== undefined && max !== undefined) {
    return ` ${min}–${max}`;
  }
  if (max !== undefined) {
    return ` ≤${max}`;
  }
  if (min !== undefined) {
    return ` ≥${min}`;
  }
  return "";
}

/** A compact, TypeScript-like description of a Zod schema. */
export function describeSchema(s: z.ZodType, indent = ""): string {
  const { schema } = unwrap(s);
  if (indent.length > 24) {
    return "…";
  }
  if (schema === richTextSchema) {
    return "RichText (write Markdown)";
  }
  if (schema === hrefSchema) {
    return "Link (/path, #id, https:, mailto: or tel:)";
  }
  if (schema === mediaIdSchema) {
    return "MediaId (from search_media)";
  }
  if (schema === colorSchema) {
    return "Color";
  }
  const d = def(schema);
  switch (d.type) {
    case "string":
      return `string${lengthNote(schema)}`;
    case "number": {
      const n = schema as unknown as {
        minValue: number | null;
        maxValue: number | null;
        isInt: boolean;
      };
      const range =
        n.minValue !== null &&
        n.maxValue !== null &&
        Number.isFinite(n.minValue) &&
        Number.isFinite(n.maxValue)
          ? ` ${n.minValue}–${n.maxValue}`
          : "";
      return `${n.isInt ? "integer" : "number"}${range}`;
    }
    case "boolean":
      return "boolean";
    case "literal":
      return (d.values as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
    case "enum":
      return Object.values(d.entries as Record<string, string>)
        .map((v) => JSON.stringify(v))
        .join(" | ");
    case "union":
      return (d.options as z.ZodType[])
        .map((o) => describeSchema(o, indent))
        .join(" | ");
    case "array": {
      const item = describeSchema(d.element, indent);
      return `${item.includes(" ") && !item.startsWith("{") ? `(${item})` : item}[]${lengthNote(schema)}`;
    }
    case "record":
      return `Record<string, ${describeSchema(d.valueType, indent)}>`;
    case "object": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> })
        .shape;
      const keys = Object.keys(shape);
      if (keys.length === 3 && keys.join() === "desktop,tablet,mobile") {
        const each = keys.map((k) => describeSchema(shape[k]!, indent));
        if (each.every((e) => e === each[0])) {
          return `Responsive<${each[0]}>`;
        }
      }
      const inner = indent + "  ";
      const fields = Object.entries(shape).map(([key, field]) => {
        const { optional } = unwrap(field);
        const desc = (field as { description?: string }).description;
        return `${inner}${key}${optional ? "?" : ""}: ${describeSchema(field, inner)};${desc ? ` // ${desc}` : ""}`;
      });
      return `{\n${fields.join("\n")}\n${indent}}`;
    }
    case "unknown":
    case "any":
      return "unknown";
    default:
      return d.type;
  }
}

// ---------------------------------------------------------------------------------------------
// Rich text ↔ Markdown along a schema

/** Applies `fn` to every rich-text value in `value` (props or a merge-patch of them), following `schema`. */
function mapRichText(
  schema: z.ZodType,
  value: unknown,
  fn: (v: unknown) => unknown
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const { schema: s } = unwrap(schema);
  if (s === richTextSchema) {
    return fn(value);
  }
  const d = def(s);
  if (
    d.type === "object" &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const shape = (s as unknown as { shape: Record<string, z.ZodType> }).shape;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shape[k] ? mapRichText(shape[k], v, fn) : v;
    }
    return out;
  }
  if (d.type === "array" && Array.isArray(value)) {
    return value.map((item) => mapRichText(d.element, item, fn));
  }
  if (d.type === "union") {
    // Only object unions carry rich text (none today); try each option that is an object.
    for (const option of d.options as z.ZodType[]) {
      if (def(unwrap(option).schema).type === "object") {
        return mapRichText(option, value, fn);
      }
    }
  }
  return value;
}

const isRichTextDoc = (v: unknown): v is RichTextDoc =>
  typeof v === "object" &&
  v !== null &&
  (v as { type?: unknown }).type === "doc";

/** Block props as the agent sees them: rich text as Markdown strings. */
export function propsForAgent(blockDef: AnyBlockDef, props: unknown): unknown {
  return mapRichText(blockDef.schema, props, (v) =>
    isRichTextDoc(v) ? toMarkdown(v) : v
  );
}

/** Props (or a props merge-patch) from the agent: Markdown strings at rich-text fields become documents. */
export function propsFromAgent(blockDef: AnyBlockDef, props: unknown): unknown {
  return mapRichText(blockDef.schema, props, (v) =>
    typeof v === "string" ? fromMarkdown(v) : v
  );
}

// ---------------------------------------------------------------------------------------------
// Catalogue text

const STYLE_GUIDE = `Every block has an optional \`style\` (BlockStyle). Responsive values are objects keyed by device: \`desktop\` is the base, \`tablet\` (768–1023px) and \`mobile\` (<768px) override it; an unset device inherits the next larger one. Spacing is in px on a 4px grid. \`Responsive<T>\` is \`{ desktop?: T; tablet?: T; mobile?: T }\`. A \`Color\` is \`{ "token": <brand token> }\` (preferred; tokens: ${BRAND_TOKENS.join(", ")}) or \`{ "hex": "#rrggbb" }\`.
To change style, use an \`update\` op with a \`style\` merge-patch: only the keys you send change, \`null\` removes a key (falls back to inherited/default), arrays replace wholesale. Example (more room and a cyan accent on mobile only): {"op":"update","key":"k1","style":{"padding":{"mobile":{"top":64,"bottom":64}},"colors":{"accent":{"token":"accent"}}}}.
\`hide\` hides a block or element per device ({"mobile": true}). \`elements\` styles a block's named elements; each block lists which elements exist and which properties each honours.
BlockStyle:
${describeSchema(blockStyleSchema)}`;

function blockEntry(d: AnyBlockDef): string {
  const elements = Object.entries(d.elements)
    .map(([name, props]) => `${name} [${props.join(", ")}]`)
    .join("; ");
  const lines = [
    `### ${d.type} — ${d.label} (${d.category}, version ${d.version})`,
    d.ai,
    `props: ${describeSchema(d.schema)}`,
    `styleable elements: ${elements || "none"}`,
  ];
  if (d.onCard?.length) {
    lines.push(
      `text on translucent cards (contrast can't be rated): ${d.onCard.join(", ")}`
    );
  }
  if (d.defaultStyle) {
    lines.push(`default style: ${JSON.stringify(d.defaultStyle)}`);
  }
  return lines.join("\n");
}

/** The block and style catalogue for the system prompt. Deterministic. */
export function blockCatalogue(
  defs: readonly AnyBlockDef[] = listBlockDefs()
): string {
  return [
    "## Blocks",
    "Arrays of objects with a `_key` need a unique short `_key` per item (letters/digits). New blocks need a unique block `_key` too.",
    ...defs.map(blockEntry),
    "## Style",
    STYLE_GUIDE,
  ].join("\n\n");
}

/** One block type for `list_block_types` (the same text as the catalogue entry). */
export function blockTypeSummaries(
  defs: readonly AnyBlockDef[] = listBlockDefs()
) {
  return defs.map((d) => ({
    type: d.type,
    label: d.label,
    category: d.category,
    version: d.version,
    ai: d.ai,
    props: describeSchema(d.schema),
    elements: d.elements,
    ...(d.defaultStyle && { defaultStyle: d.defaultStyle }),
  }));
}

/** `list_style_tokens`. */
export function styleTokens() {
  return {
    brandColors: BRAND_TOKENS.map((token) => ({
      token,
      css: TOKEN_CSS[token],
    })),
    gradients: [
      "none",
      "dark",
      "ink-rise",
      "primary-glow",
      "accent-glow",
      "accent-edge",
      "accent-primary",
    ],
    spacing: {
      gridPx: 4,
      padding: { top: [0, 512], bottom: [0, 512], x: [0, 256] },
      margin: { top: [-256, 512], bottom: [-256, 512] },
      gap: [0, 256],
    },
    maxWidths: MAX_WIDTHS,
    textSizes: TEXT_SIZES,
    breakpoints: { desktop: "≥1024px", tablet: "768–1023px", mobile: "<768px" },
    borders: ["none", "cyber", "subtle"],
    contrast:
      "WCAG AA: 4.5:1 for body text, 3:1 for large text (≥24px). Only solid colour-on-colour pairs can be rated.",
  };
}
