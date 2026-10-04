/** Small JSON helpers shared by the ops engine, summaries and the page service. */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * JSON merge-patch (RFC 7396): objects merge recursively, `null` deletes a key, anything
 * else (arrays included) replaces wholesale. Returns a new value; inputs are not mutated,
 * untouched subtrees are shared with `target`.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }
  const out: PlainObject = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (v !== undefined) {
      out[k] = mergePatch(out[k], v);
    }
  }
  return out;
}

/**
 * The merge-patch that turns `after` back into `before`, given `after = mergePatch(before, patch)`.
 * Only keys `patch` touched are included. Returns `undefined` when no merge-patch can express
 * the undo exactly (e.g. `before` holds a `null` leaf, or was not an object); callers fall back.
 */
export function inversePatch(
  before: unknown,
  patch: PlainObject
): PlainObject | undefined {
  const after = mergePatch(before, patch);
  const inv: PlainObject = {};
  const prev = isPlainObject(before) ? before : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      continue;
    }
    if (!(k in prev) || prev[k] === undefined) {
      inv[k] = null;
    } else if (isPlainObject(v) && isPlainObject(prev[k])) {
      const sub = inversePatch(prev[k], v);
      if (!sub) {
        return;
      }
      inv[k] = sub;
    } else {
      inv[k] = prev[k];
    }
  }
  return deepEqual(mergePatch(after, inv), before) ? inv : undefined;
}
