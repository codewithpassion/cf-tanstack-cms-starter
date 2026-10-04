import { nanoid } from "nanoid";

import type {
  Block,
  BlockKey,
  InsertAt,
  NewBlock,
  Op,
  PageDoc,
} from "../types";

import { deepEqual, inversePatch, mergePatch, type PlainObject } from "./json";

/** Pure: no I/O, safe for the editor and the server. */

export type OpErrorCode =
  | "UNKNOWN_OP"
  | "UNKNOWN_KEY"
  | "DUPLICATE_KEY"
  | "BAD_POSITION"
  | "NO_POST";

export class OpError extends Error {
  readonly code: OpErrorCode;
  readonly opIndex: number;

  constructor(code: OpErrorCode, opIndex: number, message: string) {
    super(`op ${opIndex}: ${message}`);
    this.name = "OpError";
    this.code = code;
    this.opIndex = opIndex;
  }
}

export type ApplyResult = {
  doc: PageDoc;
  /** Undoes `ops` exactly: applyOps(result.doc, result.inverse).doc deep-equals the input doc. */
  inverse: Op[];
  /**
   * `ops` with generated `_key`s filled in. Send these (not the originals) to the server and keep
   * them for redo, so every replay produces the same keys.
   */
  ops: Op[];
};

/**
 * Applies `ops` in order and returns a new doc. The input doc is never mutated; unchanged
 * blocks are shared with it. Throws `OpError` on the first bad op (nothing is applied).
 */
export function applyOps(
  input: PageDoc,
  ops: Op[],
  opts: { genKey?: () => string } = {}
): ApplyResult {
  const genKey = opts.genKey ?? (() => nanoid(10));
  let doc = input;
  const inverses: Op[][] = [];
  const applied: Op[] = [];

  ops.forEach((rawOp, i) => {
    const op = structuredClone(rawOp);
    const fail = (code: OpErrorCode, msg: string) => new OpError(code, i, msg);
    const { blocks } = doc;
    const find = (key: BlockKey): { idx: number; block: Block } => {
      const idx = blocks.findIndex((b) => b._key === key);
      const block = blocks[idx];
      if (!block) {
        throw fail("UNKNOWN_KEY", `no block with key "${key}"`);
      }
      return { block, idx };
    };

    switch (op.op) {
      case "insert": {
        const block = toBlock(op.block, op.block._key ?? genKey());
        if (blocks.some((b) => b._key === block._key)) {
          throw fail("DUPLICATE_KEY", `key "${block._key}" already exists`);
        }
        const at = resolvePosition(blocks, op.at, fail);
        doc = { ...doc, blocks: insertAt(blocks, at, block) };
        applied.push({ ...op, block });
        inverses.push([{ op: "remove", key: block._key }]);
        break;
      }
      case "update": {
        const { idx, block: old } = find(op.key);
        const next = patchBlock(old, op);
        doc = { ...doc, blocks: setAt(blocks, idx, next) };
        applied.push(op);
        inverses.push([inverseUpdate(old, next, op)]);
        break;
      }
      case "replace": {
        const { idx, block: old } = find(op.key);
        const block = toBlock(op.block, op.key);
        doc = { ...doc, blocks: setAt(blocks, idx, block) };
        applied.push({ ...op, block });
        inverses.push([{ op: "replace", key: op.key, block: old }]);
        break;
      }
      case "move": {
        const { idx: from, block: moved } = find(op.key);
        checkPosition(op.to, fail);
        if (op.to.after === op.key || op.to.before === op.key) {
          throw fail(
            "BAD_POSITION",
            `block "${op.key}" cannot be positioned relative to itself`
          );
        }
        const rest = removeAt(blocks, from);
        const to = resolvePosition(rest, op.to, fail);
        doc = { ...doc, blocks: insertAt(rest, to, moved) };
        applied.push(op);
        inverses.push([{ op: "move", key: op.key, to: { index: from } }]);
        break;
      }
      case "remove": {
        const { idx, block: removed } = find(op.key);
        doc = { ...doc, blocks: removeAt(blocks, idx) };
        applied.push(op);
        inverses.push([{ op: "insert", at: { index: idx }, block: removed }]);
        break;
      }
      case "setSeo": {
        const inv = metaInverse(doc.seo, op.seo);
        doc = { ...doc, seo: mergePatch(doc.seo, op.seo) as PageDoc["seo"] };
        applied.push(op);
        inverses.push([{ op: "setSeo", seo: inv }]);
        break;
      }
      case "setPost": {
        if (!doc.post) {
          throw fail("NO_POST", "doc has no post metadata");
        }
        const inv = metaInverse(doc.post, op.post);
        doc = {
          ...doc,
          post: mergePatch(doc.post, op.post) as PageDoc["post"],
        };
        applied.push(op);
        inverses.push([{ op: "setPost", post: inv }]);
        break;
      }
      default:
        throw fail(
          "UNKNOWN_OP",
          `unknown op ${JSON.stringify((op as { op?: unknown }).op)}`
        );
    }
  });

  return { doc, inverse: inverses.reverse().flat(), ops: applied };
}

function toBlock(b: NewBlock, key: BlockKey): Block {
  const block: Block = {
    _key: key,
    _type: b._type,
    _v: b._v ?? 1,
    props: b.props,
  };
  if (b.style !== undefined) {
    block.style = b.style;
  }
  return block;
}

function resolvePosition(
  blocks: Block[],
  at: InsertAt,
  fail: (code: OpErrorCode, msg: string) => OpError
): number {
  checkPosition(at, fail);
  const given = [at.after, at.before, at.index].filter(
    (v) => v !== undefined
  ).length;
  if (given > 1) {
    throw fail("BAD_POSITION", "give at most one of after, before, index");
  }
  if (at.index !== undefined) {
    if (
      !Number.isInteger(at.index) ||
      at.index < 0 ||
      at.index > blocks.length
    ) {
      throw fail(
        "BAD_POSITION",
        `index ${at.index} is outside 0..${blocks.length}`
      );
    }
    return at.index;
  }
  const anchor = at.after ?? at.before;
  if (anchor === undefined) {
    return blocks.length;
  }
  const idx = blocks.findIndex((b) => b._key === anchor);
  if (idx < 0) {
    throw fail("UNKNOWN_KEY", `no block with key "${anchor}"`);
  }
  return at.after === undefined ? idx : idx + 1;
}

/** Ops can come from untrusted JSON: a missing or non-object position is a BAD_POSITION, not a TypeError. */
function checkPosition(
  at: unknown,
  fail: (code: OpErrorCode, msg: string) => OpError
): asserts at is InsertAt {
  if (typeof at !== "object" || at === null || Array.isArray(at)) {
    throw fail("BAD_POSITION", "position must be an object");
  }
}

type UpdateOp = Extract<Op, { op: "update" }>;

function patchBlock(
  block: Block,
  patch: Pick<UpdateOp, "props" | "style">
): Block {
  let next: Block = { ...block };
  if (patch.props) {
    next.props = mergePatch(block.props, patch.props);
  }
  if (patch.style) {
    const style = mergePatch(block.style, patch.style) as PlainObject;
    // An empty style object means "no overrides": drop it so docs stay clean.
    if (Object.keys(style).length) {
      next.style = style;
    } else {
      const { style: _dropped, ...rest } = next;
      next = rest;
    }
  }
  return next;
}

/** A merge-patch inverse when it restores `old` exactly, otherwise `replace` with `old`. */
function inverseUpdate(old: Block, next: Block, op: UpdateOp): Op {
  const inv: UpdateOp = { op: "update", key: old._key };
  if (op.props) {
    inv.props = inversePatch(old.props, op.props);
  }
  if (op.style) {
    inv.style = inversePatch(old.style, op.style as PlainObject);
  }
  const exact =
    (!op.props || inv.props) &&
    (!op.style || inv.style) &&
    deepEqual(patchBlock(next, inv), old);
  return exact ? inv : { op: "replace", key: old._key, block: old };
}

/** PageSeo and PostMeta hold no nulls, so a merge-patch inverse always exists for valid docs. */
function metaInverse(before: object, patch: object): PlainObject {
  const inv = inversePatch(before, patch as PlainObject);
  if (!inv) {
    throw new Error(
      "seo/post metadata contains null values and cannot be patched reversibly"
    );
  }
  return inv;
}

function insertAt<T>(arr: readonly T[], i: number, v: T): T[] {
  return [...arr.slice(0, i), v, ...arr.slice(i)];
}

function removeAt<T>(arr: readonly T[], i: number): T[] {
  return [...arr.slice(0, i), ...arr.slice(i + 1)];
}

function setAt<T>(arr: readonly T[], i: number, v: T): T[] {
  return arr.map((x, j) => (j === i ? v : x));
}
