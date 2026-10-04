import { type BlockType, createBlock } from "../blocks/registry";
import type { BlockStyle, InsertAt, MergePatch, Op, PageDoc } from "../types";

/** Op builders for the block toolbar, layers panel and palette. Null when the action doesn't apply. */

export function moveBy(doc: PageDoc, key: string, delta: -1 | 1): Op | null {
  const i = doc.blocks.findIndex((b) => b._key === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.blocks.length) {
    return null;
  }
  return { op: "move", key, to: { index: j } };
}

/** Drag-and-drop: `to` is the block's index in the final order. */
export function moveTo(doc: PageDoc, key: string, to: number): Op | null {
  const i = doc.blocks.findIndex((b) => b._key === key);
  if (i < 0 || i === to || to < 0 || to >= doc.blocks.length) {
    return null;
  }
  return { op: "move", key, to: { index: to } };
}

/** A copy right after the original; applyOps gives it a new key. */
export function duplicate(doc: PageDoc, key: string): Op | null {
  const block = doc.blocks.find((b) => b._key === key);
  if (!block) {
    return null;
  }
  const { _key: _, ...rest } = structuredClone(block);
  return { op: "insert", at: { after: key }, block: rest };
}

export function remove(doc: PageDoc, key: string): Op | null {
  return doc.blocks.some((b) => b._key === key) ? { op: "remove", key } : null;
}

/** `style`: merge-patched over the block's default style (posts: postBlockStyle). */
export function insertNew(
  type: BlockType,
  at: InsertAt,
  style?: MergePatch<BlockStyle>
): Op {
  return { op: "insert", at, block: createBlock(type, style ? { style } : {}) };
}

/** Where "+ Add block" inserts: after the selected block, else at the end. */
export function defaultInsertAt(
  doc: PageDoc,
  selectedKey: string | null
): InsertAt {
  return selectedKey && doc.blocks.some((b) => b._key === selectedKey)
    ? { after: selectedKey }
    : {};
}
