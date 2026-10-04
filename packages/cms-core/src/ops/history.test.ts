import { describe, expect, it } from "bun:test";
import type { Op, PageDoc } from "../types";
import { applyOps } from "./apply-ops";
import { createHistory } from "./history";
import { doc, nth } from "./test-docs";

/** A tiny editor: applies ops, records them, and replays undo/redo. */
function editor() {
  let t = 0;
  const history = createHistory({ now: () => t });
  let current: PageDoc = doc();
  return {
    history,
    get doc() {
      return current;
    },
    tick(ms: number) {
      t += ms;
    },
    edit(...ops: Op[]) {
      const r = applyOps(current, ops);
      current = r.doc;
      history.push(r.ops, r.inverse);
    },
    undo() {
      const ops = history.undo();
      if (ops) {
        current = applyOps(current, ops).doc;
      }
    },
    redo() {
      const ops = history.redo();
      if (ops) {
        current = applyOps(current, ops).doc;
      }
    },
  };
}

const heading = (text: string): Op => ({
  op: "update",
  key: "hero",
  props: { heading: text },
});
const headingOf = (d: PageDoc) =>
  (nth(d.blocks, 0).props as { heading: string }).heading;

describe("createHistory", () => {
  it("merges typing in one field into a single undo step", () => {
    const e = editor();
    for (const text of ["H", "He", "Hel", "Hell"]) {
      e.tick(300);
      e.edit(heading(text));
    }
    e.undo();
    expect(e.doc).toEqual(doc());
    expect(e.history.canUndo()).toBe(false);
    e.redo();
    expect(headingOf(e.doc)).toBe("Hell");
  });

  it("starts a new step after a pause longer than the window", () => {
    const e = editor();
    e.edit(heading("A"));
    e.tick(1001);
    e.edit(heading("B"));
    e.undo();
    expect(headingOf(e.doc)).toBe("A");
  });

  it("does not merge edits to a different prop, block or a multi-field update", () => {
    const e = editor();
    e.edit(heading("A"));
    e.edit({ op: "update", key: "hero", props: { sub: "x" } });
    e.edit({ op: "update", key: "cta", props: { label: "x" } });
    e.edit({ op: "update", key: "cta", props: { label: "y", extra: 1 } });
    let steps = 0;
    while (e.history.canUndo()) {
      e.undo();
      steps += 1;
    }
    expect(steps).toBe(4);
    expect(e.doc).toEqual(doc());
  });

  it("merges a canvas drag of one style property", () => {
    const e = editor();
    for (const top of [40, 36, 32]) {
      e.edit({
        op: "update",
        key: "hero",
        style: { padding: { mobile: { top } } },
      });
    }
    e.undo();
    expect(e.doc).toEqual(doc());
  });

  it("never merges into a step the user undid back to", () => {
    const e = editor();
    e.edit(heading("A"));
    e.tick(2000);
    e.edit(heading("B"));
    e.undo();
    e.edit(heading("C"));
    e.undo();
    expect(headingOf(e.doc)).toBe("A");
  });

  it("clears redo on a new edit", () => {
    const e = editor();
    e.edit(heading("A"));
    e.undo();
    expect(e.history.canRedo()).toBe(true);
    e.edit({ op: "remove", key: "cta" });
    expect(e.history.canRedo()).toBe(false);
    expect(e.history.redo()).toBeNull();
  });

  it("redoes inserts with the same generated key", () => {
    const e = editor();
    e.edit({ op: "insert", at: {}, block: { _type: "stats", props: {} } });
    const key = nth(e.doc.blocks, 3)._key;
    e.edit({ op: "update", key, props: { n: 1 } });
    e.undo();
    e.undo();
    e.redo();
    e.redo();
    expect(nth(e.doc.blocks, 3)).toMatchObject({ _key: key, props: { n: 1 } });
  });

  it("returns null when there is nothing to undo", () => {
    expect(createHistory().undo()).toBeNull();
  });
});
