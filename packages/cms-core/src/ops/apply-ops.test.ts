// biome-ignore-all lint/suspicious/noMisplacedAssertion: run() and expectOpError() are assertion helpers called from tests.
import { describe, expect, it } from "bun:test";
import type { Op, PageDoc } from "../types";
import { applyOps, OpError } from "./apply-ops";
import { block, deepFreeze, doc, nth, post } from "./test-docs";

const keys = (d: PageDoc) => d.blocks.map((b) => b._key);
const counter = () => {
  let n = 0;
  return () => {
    n += 1;
    return `k${n}`;
  };
};

/** Applies ops, checks the input was not mutated and that the inverse undoes them exactly. */
function run(input: PageDoc, ops: Op[]) {
  const frozen = deepFreeze(structuredClone(input));
  const result = applyOps(frozen, ops, { genKey: counter() });
  expect(applyOps(result.doc, result.inverse).doc).toEqual(input);
  // Replaying the normalized ops reproduces the result (needed for redo and server saves).
  expect(applyOps(input, result.ops).doc).toEqual(result.doc);
  return result;
}

function expectOpError(
  fn: () => unknown,
  code: OpError["code"],
  opIndex: number
) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OpError);
    expect((e as OpError).code).toBe(code);
    expect((e as OpError).opIndex).toBe(opIndex);
    return;
  }
  throw new Error("expected an OpError");
}

describe("insert", () => {
  const nb = { _type: "cta", props: { label: "New" } };

  it("appends by default, generating _key and _v", () => {
    const { doc: d } = run(doc(), [{ op: "insert", at: {}, block: nb }]);
    expect(keys(d)).toEqual(["hero", "faq", "cta", "k1"]);
    expect(nth(d.blocks, 3)).toEqual({
      _key: "k1",
      _type: "cta",
      _v: 1,
      props: { label: "New" },
    });
  });

  it("positions after, before and at an index", () => {
    expect(
      keys(run(doc(), [{ op: "insert", at: { after: "hero" }, block: nb }]).doc)
    ).toEqual(["hero", "k1", "faq", "cta"]);
    expect(
      keys(
        run(doc(), [{ op: "insert", at: { before: "hero" }, block: nb }]).doc
      )
    ).toEqual(["k1", "hero", "faq", "cta"]);
    expect(
      keys(run(doc(), [{ op: "insert", at: { index: 2 }, block: nb }]).doc)
    ).toEqual(["hero", "faq", "k1", "cta"]);
    expect(
      keys(run(doc(), [{ op: "insert", at: { index: 3 }, block: nb }]).doc)
    ).toEqual(["hero", "faq", "cta", "k1"]);
  });

  it("keeps a supplied _key and _v", () => {
    const { doc: d } = run(doc(), [
      { op: "insert", at: {}, block: { ...nb, _key: "mine", _v: 2 } },
    ]);
    expect(nth(d.blocks, 3)).toMatchObject({ _key: "mine", _v: 2 });
  });

  it("returns normalized ops carrying the generated key", () => {
    const { ops } = applyOps(doc(), [{ op: "insert", at: {}, block: nb }], {
      genKey: () => "gen",
    });
    expect(ops).toEqual([
      {
        op: "insert",
        at: {},
        block: { _key: "gen", _type: "cta", _v: 1, props: { label: "New" } },
      },
    ]);
  });

  it("rejects duplicate keys, unknown anchors and bad positions", () => {
    expectOpError(
      () =>
        applyOps(doc(), [
          { op: "insert", at: {}, block: { ...nb, _key: "faq" } },
        ]),
      "DUPLICATE_KEY",
      0
    );
    expectOpError(
      () =>
        applyOps(doc(), [{ op: "insert", at: { after: "nope" }, block: nb }]),
      "UNKNOWN_KEY",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "insert", at: { index: 4 }, block: nb }]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "insert", at: { index: -1 }, block: nb }]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "insert", at: { index: 1.5 }, block: nb }]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () =>
        applyOps(doc(), [
          { op: "insert", at: { after: "hero", index: 0 }, block: nb },
        ]),
      "BAD_POSITION",
      0
    );
  });
});

describe("update (merge-patch)", () => {
  it("merges props recursively, deletes on null, replaces arrays wholesale", () => {
    const { doc: d } = run(doc(), [
      {
        op: "update",
        key: "hero",
        props: { heading: "Hi", sub: { em: null, size: "lg" }, links: ["c"] },
      },
    ]);
    expect(nth(d.blocks, 0).props).toEqual({
      heading: "Hi",
      sub: { text: "Sub", size: "lg" },
      links: ["c"],
    });
  });

  it("merges style per device and deletes overrides with null", () => {
    const { doc: d } = run(doc(), [
      {
        op: "update",
        key: "hero",
        style: { padding: { mobile: { top: 32 }, tablet: { top: 64 } } },
      },
      { op: "update", key: "hero", style: { padding: { desktop: null } } },
    ]);
    expect(nth(d.blocks, 0).style).toEqual({
      padding: { mobile: { top: 32 }, tablet: { top: 64 } },
    });
  });

  it("adds style to a block that had none, and undoes back to no style", () => {
    const { doc: d, inverse } = run(doc(), [
      { op: "update", key: "cta", style: { border: "glow" } },
    ]);
    expect(nth(d.blocks, 2).style).toEqual({ border: "glow" });
    expect(applyOps(d, inverse).doc.blocks[2]).not.toHaveProperty("style");
  });

  it("drops style once every override is removed", () => {
    const { doc: d } = run(doc(), [
      { op: "update", key: "hero", style: { padding: null } },
    ]);
    expect(nth(d.blocks, 0)).not.toHaveProperty("style");
  });

  it("uses a small update as the inverse when it is exact", () => {
    const { inverse } = run(doc(), [
      { op: "update", key: "hero", props: { heading: "Hi" } },
    ]);
    expect(inverse).toEqual([
      { op: "update", key: "hero", props: { heading: "Hello" } },
    ]);
  });

  it("falls back to replace when a merge-patch cannot restore the block", () => {
    const input = doc([block("a", "x", { image: { id: null, alt: "x" } })]);
    const { inverse } = run(input, [
      { op: "update", key: "a", props: { image: "flat" } },
    ]);
    expect(nth(inverse, 0).op).toBe("replace");
  });

  it("rejects unknown keys", () => {
    expectOpError(
      () =>
        applyOps(doc(), [
          { op: "remove", key: "faq" },
          { op: "update", key: "nope", props: {} },
        ]),
      "UNKNOWN_KEY",
      1
    );
  });
});

describe("replace", () => {
  it("keeps the existing _key and defaults _v", () => {
    const { doc: d } = run(doc(), [
      {
        op: "replace",
        key: "faq",
        block: { _key: "ignored", _type: "steps", props: { n: 1 } },
      },
    ]);
    expect(nth(d.blocks, 1)).toEqual({
      _key: "faq",
      _type: "steps",
      _v: 1,
      props: { n: 1 },
    });
  });
});

describe("move", () => {
  it("moves by index, after and before (positions count without the moved block)", () => {
    expect(
      keys(run(doc(), [{ op: "move", key: "hero", to: { index: 2 } }]).doc)
    ).toEqual(["faq", "cta", "hero"]);
    expect(
      keys(run(doc(), [{ op: "move", key: "cta", to: { index: 0 } }]).doc)
    ).toEqual(["cta", "hero", "faq"]);
    expect(
      keys(run(doc(), [{ op: "move", key: "hero", to: { after: "faq" } }]).doc)
    ).toEqual(["faq", "hero", "cta"]);
    expect(
      keys(run(doc(), [{ op: "move", key: "cta", to: { before: "faq" } }]).doc)
    ).toEqual(["hero", "cta", "faq"]);
    expect(keys(run(doc(), [{ op: "move", key: "faq", to: {} }]).doc)).toEqual([
      "hero",
      "cta",
      "faq",
    ]);
  });

  it("rejects self anchors and out-of-range indexes", () => {
    expectOpError(
      () => applyOps(doc(), [{ op: "move", key: "faq", to: { after: "faq" } }]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "move", key: "faq", to: { index: 3 } }]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "move", key: "nope", to: { index: 0 } }]),
      "UNKNOWN_KEY",
      0
    );
  });
});

describe("remove", () => {
  it("removes a block and re-inserts it on undo", () => {
    const { doc: d, inverse } = run(doc(), [{ op: "remove", key: "faq" }]);
    expect(keys(d)).toEqual(["hero", "cta"]);
    expect(inverse).toEqual([
      { op: "insert", at: { index: 1 }, block: nth(doc().blocks, 1) },
    ]);
  });
});

describe("setSeo / setPost", () => {
  it("deep merge-patches seo, null deletes", () => {
    const input = doc(undefined, {
      seo: { ...doc().seo, canonical: "https://x" },
    });
    const { doc: d } = run(input, [
      {
        op: "setSeo",
        seo: { title: "New", canonical: null, social: { title: "Share" } },
      },
    ]);
    expect(d.seo.title).toBe("New");
    expect(d.seo).not.toHaveProperty("canonical");
    expect(d.seo.social).toEqual({ title: "Share" });
    expect(d.seo.robots).toEqual({ index: true, follow: true });
  });

  it("patches post metadata, arrays wholesale", () => {
    const { doc: d } = run(doc(undefined, { post: post() }), [
      { op: "setPost", post: { tags: ["x", "y"], excerpt: "E" } },
    ]);
    expect(d.post).toMatchObject({
      tags: ["x", "y"],
      excerpt: "E",
      author: "Jane",
    });
  });

  it("fails with NO_POST on a page without post metadata", () => {
    expectOpError(
      () => applyOps(doc(), [{ op: "setPost", post: { excerpt: "E" } }]),
      "NO_POST",
      0
    );
  });
});

describe("batches", () => {
  it("is all-or-nothing and leaves the input untouched", () => {
    const input = deepFreeze(doc());
    expectOpError(
      () =>
        applyOps(input, [
          { op: "remove", key: "hero" },
          { op: "remove", key: "hero" },
        ]),
      "UNKNOWN_KEY",
      1
    );
    expect(keys(input)).toEqual(["hero", "faq", "cta"]);
  });

  it("rejects unknown ops and missing positions with an OpError, not a TypeError", () => {
    expectOpError(
      () => applyOps(doc(), [{ op: "rename", key: "cta" } as never]),
      "UNKNOWN_OP",
      0
    );
    const nb = { _type: "cta", props: {} };
    expectOpError(
      () => applyOps(doc(), [{ op: "insert", block: nb } as never]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "insert", at: null, block: nb } as never]),
      "BAD_POSITION",
      0
    );
    expectOpError(
      () => applyOps(doc(), [{ op: "move", key: "faq" } as never]),
      "BAD_POSITION",
      0
    );
  });

  it("does not alias caller-owned op payloads into the doc", () => {
    const props = { label: "A" };
    const { doc: d } = applyOps(doc(), [
      { op: "insert", at: {}, block: { _type: "cta", props } },
    ]);
    props.label = "changed";
    expect(nth(d.blocks, 3).props).toEqual({ label: "A" });
  });

  it("shares unchanged blocks with the input", () => {
    const input = doc();
    const { doc: d } = applyOps(input, [
      { op: "update", key: "cta", props: { label: "X" } },
    ]);
    expect(nth(d.blocks, 0)).toBe(nth(input.blocks, 0));
  });

  it("inverts a mixed sequence in the right order", () => {
    run(doc(undefined, { post: post() }), [
      {
        op: "insert",
        at: { after: "hero" },
        block: { _type: "stats", props: { n: [1, 2] } },
      },
      {
        op: "update",
        key: "k1",
        props: { n: [3] },
        style: { gap: { mobile: 8 } },
      },
      { op: "move", key: "k1", to: { index: 0 } },
      {
        op: "update",
        key: "hero",
        props: { heading: null, sub: { text: "S2" } },
      },
      {
        op: "replace",
        key: "faq",
        block: { _type: "faq", props: { items: [] } },
      },
      { op: "remove", key: "cta" },
      { op: "setSeo", seo: { title: "T", focusKeyphrase: "ai" } },
      { op: "setPost", post: { featuredImage: { mediaId: "m1", alt: "a" } } },
      { op: "remove", key: "k1" },
    ]);
  });

  it("round-trips random op sequences (property test)", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const pick = <T>(xs: T[]) => nth(xs, rand(xs.length));
    const values = [
      null,
      0,
      48,
      "x",
      true,
      ["a"],
      { top: 8 },
      { mobile: { top: 16 } },
    ];
    // Draws from rand() in the same order as the source's inline ternary, so the sequence is unchanged.
    const randomOp = (i: number, ks: string[]): Op => {
      const key = ks.length ? pick(ks) : undefined;
      const kind = key ? rand(7) : 0;
      if (key === undefined || kind === 0) {
        return {
          op: "insert",
          at: { index: rand(ks.length + 1) },
          block: { _key: `r${i}`, _type: "t", props: { v: pick(values) } },
        };
      }
      switch (kind) {
        case 1:
          return {
            op: "update",
            key,
            props: { [pick(["heading", "sub", "v", "items"])]: pick(values) },
          };
        case 2:
          return {
            op: "update",
            key,
            style: {
              [pick(["padding", "gap", "border"])]: pick(values),
            } as never,
          };
        case 3:
          return { op: "move", key, to: { index: rand(ks.length) } };
        case 4:
          return { op: "remove", key };
        case 5:
          return { op: "replace", key, block: { _type: "r", props: {} } };
        default:
          return {
            op: "setSeo",
            seo: { title: `t${rand(9)}`, canonical: pick([null, "c"]) },
          };
      }
    };

    for (let round = 0; round < 300; round += 1) {
      let current = doc(undefined, { post: post() });
      const ops: Op[] = [];
      for (let i = 0; i < 1 + rand(6); i += 1) {
        const op = randomOp(i, keys(current));
        ops.push(op);
        current = applyOps(current, [op]).doc;
      }
      const start = doc(undefined, { post: post() });
      const result = applyOps(start, ops);
      expect(applyOps(result.doc, result.inverse).doc).toEqual(start);
    }
  });
});
