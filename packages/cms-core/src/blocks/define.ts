import { z } from "zod";

import type {
  Block,
  BlockStyle,
  ElementStyle,
  JsonLd,
  PageDoc,
} from "../types";

export type BlockCategory = "layout" | "content" | "media" | "conversion";

export type BlockJsonLdContext = { doc: PageDoc; block: Block };

export type ElementProp = keyof ElementStyle;

/**
 * One per block type: the pure half of a block (schema, defaults, guidance). The web app pairs
 * each def with its React `Component`, a lucide `Icon` and an optional `hiddenWhen`
 * (`apps/web/src/modules/cms/blocks/registry.ts`).
 */
export type BlockDef<
  T extends string = string,
  S extends z.ZodType = z.ZodType,
> = {
  type: T;
  /** Current props version; stored as `_v` on each block. */
  version: number;
  label: string;
  /** Lucide icon name in kebab-case (e.g. "layout-template"); the web registry resolves it to a component. */
  icon: string;
  category: BlockCategory;
  schema: S;
  defaults: () => z.output<S>;
  /** Responsive values allowed. Copied into new blocks by createBlock; for older blocks, used for a property their style leaves unset on every device. */
  defaultStyle?: BlockStyle;
  /**
   * Styleable elements for `style.elements` and the properties each one honours, e.g.
   * `{ heading: ["color", "size", "align", "hide"], items: ["align", "hide"] }`. List a property only
   * if it takes effect: an inherited color or size loses to a child's own Tailwind classes.
   */
  elements: Readonly<Record<string, readonly ElementProp[]>>;
  /**
   * Elements whose text sits on a translucent card (`cms-card` over the block background), so a
   * contrast rating against the block background would be wrong: their colours, and the block's
   * own text colours (which reach them), are rated "unknown".
   */
  onCard?: readonly string[];
  /** Guidance for the AI page agent. */
  ai: string;
  jsonLd?: (
    props: z.output<S>,
    ctx: BlockJsonLdContext
  ) => JsonLd | JsonLd[] | null;
  /** The element the JSON-LD describes: when it's hidden on every device, the block emits none. */
  jsonLdElement?: string;
  /** `migrate[n]` upgrades props from version n to n + 1. */
  // biome-ignore lint/suspicious/noExplicitAny: each migration step takes the previous version's props, whatever their shape.
  migrate?: Record<number, (old: any) => unknown>;
};

export function defineBlock<T extends string, S extends z.ZodType>(
  def: BlockDef<T, S>
): BlockDef<T, S> {
  return def;
}

/** Array items carry a stable `_key` (unique within the array) so reorders and edits stay addressable. */
export function keyedArray<T extends z.ZodObject>(item: T) {
  return item.array().superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((it, i) => {
      const key = (it as { _key?: unknown })._key;
      if (typeof key !== "string") {
        return;
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "_key"],
          message: `Duplicate _key "${key}"`,
        });
      }
      seen.add(key);
    });
  });
}

export const itemKeySchema = z.string().min(1).max(64);
