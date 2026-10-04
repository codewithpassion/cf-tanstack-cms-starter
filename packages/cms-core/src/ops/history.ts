import type { Op } from "../types";

/**
 * In-memory undo/redo for the editor. Each entry is one undo step.
 * Consecutive single-field `update`s of the same block (same top-level prop or style key)
 * within `windowMs` of the previous push merge into one step, so typing or a canvas drag
 * undoes as a whole. Push the normalized `ops` and `inverse` that `applyOps` returns.
 */

type Entry = { ops: Op[]; inverse: Op[] };

export type History = {
  push: (ops: Op[], inverse: Op[]) => void;
  /** Ops to apply to undo the last step, or null when there is nothing to undo. */
  undo: () => Op[] | null;
  /** Ops to apply to redo the last undone step, or null. */
  redo: () => Op[] | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
};

export function createHistory(
  opts: { now?: () => number; windowMs?: number } = {}
): History {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? 1000;
  const undoStack: Entry[] = [];
  const redoStack: Entry[] = [];
  // Set only by push, cleared by undo/redo: we never merge into an entry the user stepped back to.
  let last: { field: string; at: number } | null = null;

  return {
    push(ops, inverse) {
      if (!ops.length) {
        return;
      }
      redoStack.length = 0;
      const field = coalesceField(ops);
      const t = now();
      const top = undoStack.at(-1);
      if (top && field && last?.field === field && t - last.at <= windowMs) {
        top.ops = [...top.ops, ...ops];
        top.inverse = [...inverse, ...top.inverse];
      } else {
        undoStack.push({ ops, inverse });
      }
      last = field ? { field, at: t } : null;
    },
    undo() {
      const entry = undoStack.pop();
      if (!entry) {
        return null;
      }
      redoStack.push(entry);
      last = null;
      return entry.inverse;
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) {
        return null;
      }
      undoStack.push(entry);
      last = null;
      return entry.ops;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
}

/** "<key>:props.<name>" or "<key>:style.<name>" for a single-field update, else null. */
function coalesceField(ops: Op[]): string | null {
  const [op] = ops;
  if (ops.length !== 1 || op?.op !== "update") {
    return null;
  }
  const { key, props, style } = op;
  const fields = [
    ...Object.keys(props ?? {}).map((k) => `props.${k}`),
    ...Object.keys(style ?? {}).map((k) => `style.${k}`),
  ];
  return fields.length === 1 ? `${key}:${fields[0]}` : null;
}
