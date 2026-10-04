import { mergePatch } from "../ops/json";
import type { Block, BlockStyle, MergePatch, NewBlock } from "../types";
import { callout } from "./callout";
import { checklist } from "./checklist";
import { cta } from "./cta";
import type { BlockDef } from "./define";
import { faq } from "./faq";
import { featureGrid } from "./feature-grid";
import { hero } from "./hero";
import { image } from "./image";
import { logos } from "./logos";
import { postList } from "./post-list";
import { pricing } from "./pricing";
import { richText } from "./rich-text";
import { stats } from "./stats";
import { steps } from "./steps";
import { testimonial } from "./testimonial";

export const BLOCK_TYPES = [
  "hero",
  "richText",
  "featureGrid",
  "steps",
  "pricing",
  "faq",
  "cta",
  "image",
  "logos",
  "testimonial",
  "stats",
  "callout",
  "postList",
  "checklist",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

// `any` schema: each def is typed to its own props, which TS can't widen to unknown.
// biome-ignore lint/suspicious/noExplicitAny: see above.
export type AnyBlockDef = BlockDef<string, any>;

/** Every BlockType must have a definition, or this fails to compile. */
// biome-ignore lint/suspicious/noExplicitAny: as AnyBlockDef.
export const BLOCK_DEFS: { [K in BlockType]: BlockDef<K, any> } = {
  hero,
  richText,
  featureGrid,
  faq,
  cta,
  image,
  logos,
  testimonial,
  stats,
  callout,
  postList,
  steps,
  pricing,
  checklist,
};

const registry = BLOCK_DEFS;

/**
 * Types that existed once and were removed. Documents may still contain them: validation reports
 * them as retired (not unknown), and the renderer skips them (placeholder in edit mode).
 */
export const RETIRED_BLOCK_TYPES: readonly string[] = [];

export function isBlockType(type: unknown): type is BlockType {
  return typeof type === "string" && Object.hasOwn(registry, type);
}

export function getBlockDef(type: string): AnyBlockDef | undefined {
  return isBlockType(type) ? registry[type] : undefined;
}

export function listBlockDefs(): AnyBlockDef[] {
  return BLOCK_TYPES.map((type) => registry[type]);
}

export type BlockOverrides = {
  _key?: string;
  props?: Record<string, unknown>;
  style?: MergePatch<BlockStyle>;
};

/**
 * A new block with default props and the definition's `defaultStyle` copied into `style`, so every
 * value the editor shows is explicit (Webflow-like). `overrides.props` and `overrides.style` are
 * merge-patched on top (`null` removes a default).
 */
export function createBlock(
  type: BlockType,
  overrides: BlockOverrides & { _key: string }
): Block;
export function createBlock(
  type: BlockType,
  overrides?: BlockOverrides
): NewBlock;
export function createBlock(
  type: BlockType,
  overrides: BlockOverrides = {}
): NewBlock {
  const def = registry[type];
  const block: NewBlock = {
    ...(overrides._key !== undefined && { _key: overrides._key }),
    _type: type,
    _v: def.version,
    props: mergePatch(def.defaults(), overrides.props ?? {}),
  };
  const style = mergePatch(
    structuredClone(def.defaultStyle ?? {}),
    overrides.style ?? {}
  ) as BlockStyle;
  if (Object.keys(style).length) {
    block.style = style;
  }
  return block;
}

/** Applies `migrate[n]` steps from the stored `_v` up to the current version. */
export function migrateProps(
  def: AnyBlockDef,
  version: number,
  props: unknown
): { ok: true; props: unknown } | { ok: false; message: string } {
  if (version > def.version) {
    return {
      ok: false,
      message: `Block version ${version} is newer than supported (${def.version})`,
    };
  }
  let out = props;
  for (let v = version; v < def.version; v += 1) {
    const step = def.migrate?.[v];
    if (!step) {
      return {
        ok: false,
        message: `No migration for ${def.type} from version ${v}`,
      };
    }
    out = step(out);
  }
  return { ok: true, props: out };
}
