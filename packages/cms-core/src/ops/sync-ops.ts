/**
 * Ops that bring a CMS draft in line with a target document, for the imports that write CMS docs
 * (server/blog-import.ts, server/pilot-drafts.ts; run by /admin/setup and the cms:* scripts).
 * Blocks are addressed by `_key`.
 */
import type { Block, Op, PageDoc } from "../types";
import { deepEqual, isPlainObject, type PlainObject } from "./json";

/** The merge-patch that turns `from` into `to` (null deletes; arrays and leaves replace). */
export function diffPatch(from: PlainObject, to: PlainObject): PlainObject {
  const patch: PlainObject = {};
  for (const key of Object.keys(from)) {
    if (from[key] !== undefined && to[key] === undefined) {
      patch[key] = null;
    }
  }
  for (const [key, value] of Object.entries(to)) {
    if (value === undefined || deepEqual(from[key], value)) {
      continue;
    }
    const prev = from[key];
    patch[key] =
      isPlainObject(prev) && isPlainObject(value)
        ? diffPatch(prev, value)
        : value;
  }
  return patch;
}

/** Ops that turn the draft `current` into `target`: setSeo, setPost, then remove/insert/replace/move. */
export function syncOps(current: PageDoc, target: PageDoc): Op[] {
  const ops: Op[] = [];
  const seo = diffPatch(current.seo as PlainObject, target.seo as PlainObject);
  if (Object.keys(seo).length) {
    ops.push({ op: "setSeo", seo });
  }
  if (target.post) {
    const post = diffPatch(
      (current.post ?? {}) as PlainObject,
      target.post as PlainObject
    );
    if (Object.keys(post).length) {
      ops.push({ op: "setPost", post });
    }
  }

  const wanted = new Set(target.blocks.map((b) => b._key));
  const order: Block[] = [];
  for (const block of current.blocks) {
    if (wanted.has(block._key)) {
      order.push(block);
    } else {
      ops.push({ op: "remove", key: block._key });
    }
  }
  target.blocks.forEach((block, i) => {
    const at = order.findIndex((b) => b._key === block._key);
    if (at < 0) {
      ops.push({ op: "insert", at: { index: i }, block });
      order.splice(i, 0, block);
      return;
    }
    if (!deepEqual(order[at], block)) {
      ops.push({ op: "replace", key: block._key, block });
    }
    if (at !== i) {
      ops.push({ op: "move", key: block._key, to: { index: i } });
      order.splice(i, 0, ...order.splice(at, 1));
    }
  });
  return ops;
}
