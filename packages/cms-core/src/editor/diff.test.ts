// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
import { describe, expect, it } from "bun:test";

import { block, doc } from "../ops/test-docs";
import { richTextFromString } from "../richtext/schema";
import {
  diffDocs,
  diffFields,
  fieldLabel,
  isColor,
  richTextToPlain,
  wordDiff,
} from "./diff";

const statuses = (d: ReturnType<typeof diffDocs>) =>
  d.blocks.map((b) => [b.key, b.status]);

describe("diffDocs: blocks by _key", () => {
  it("finds nothing between equal documents", () => {
    expect(diffDocs(doc(), doc())).toEqual({
      blocks: [],
      seo: [],
      post: [],
      changed: false,
    });
  });

  it("reports added, removed and changed blocks in target order, removed ones where they were", () => {
    const base = doc([
      block("a", "hero", { heading: "Hi" }),
      block("b", "faq"),
      block("c", "cta", { label: "Go" }),
    ]);
    const target = doc([
      block("a", "hero", { heading: "Hello" }),
      block("n", "image"),
      block("c", "cta", { label: "Go" }),
    ]);
    const d = diffDocs(base, target);
    expect(statuses(d)).toEqual([
      ["a", "changed"],
      ["n", "added"],
      ["b", "removed"],
    ]);
    expect(d.changed).toBe(true);
  });

  it("reports only the dragged block as moved", () => {
    const base = doc([
      block("a", "x"),
      block("b", "x"),
      block("c", "x"),
      block("d", "x"),
    ]);
    const target = doc([
      block("b", "x"),
      block("c", "x"),
      block("d", "x"),
      block("a", "x"),
    ]);
    expect(statuses(diffDocs(base, target))).toEqual([["a", "moved"]]);
  });

  it("flags a moved block that also changed", () => {
    const base = doc([block("a", "x", { t: "1" }), block("b", "x")]);
    const target = doc([block("b", "x"), block("a", "x", { t: "2" })]);
    const [change] = diffDocs(base, target).blocks;
    expect(change).toMatchObject({ key: "a", status: "changed", moved: true });
  });

  it("labels post fields with the Post tab's names; other paths stay raw", () => {
    expect(fieldLabel("post.excerpt")).toBe("Post · Excerpt");
    expect(fieldLabel("post.featuredImage.alt")).toBe(
      "Post · Featured image alt text"
    );
    expect(fieldLabel("post.somethingNew")).toBe("Post · somethingNew");
    expect(fieldLabel("seo.title")).toBe("seo.title");
    expect(fieldLabel("")).toBe("");
  });

  it("diffs SEO and post fields", () => {
    const base = doc();
    const target = doc(undefined, { seo: { ...base.seo, title: "New title" } });
    expect(diffDocs(base, target).seo).toEqual([
      {
        path: "seo.title",
        kind: "changed",
        before: "Home",
        after: "New title",
        words: [
          { type: "del", text: "Home" },
          { type: "add", text: "New title" },
        ],
      },
    ]);
  });
});

describe("diffFields: field paths", () => {
  it("walks props and style to the changed leaves", () => {
    const before = block(
      "h",
      "hero",
      { heading: "Hi", sub: { text: "a", em: true } },
      {
        style: {
          padding: { mobile: { top: 48 } },
          colors: { heading: { token: "white" } },
        },
      }
    );
    const after = block(
      "h",
      "hero",
      { heading: "Hi", sub: { text: "a", em: false } },
      {
        style: {
          padding: { mobile: { top: 32 } },
          colors: { heading: { token: "accent" } },
        },
      }
    );
    const d = diffDocs(doc([before]), doc([after]));
    const change = d.blocks[0]!;
    expect(change.status).toBe("changed");
    if (change.status !== "changed") {
      return;
    }
    expect(
      change.fields.map((f) => [f.path, f.kind, f.before, f.after])
    ).toEqual([
      ["sub.em", "changed", true, false],
      ["style.padding.mobile.top", "changed", 48, 32],
      [
        "style.colors.heading",
        "changed",
        { token: "white" },
        { token: "accent" },
      ],
    ]);
  });

  it("matches list items by _key: one change per added or removed item, field paths inside kept ones", () => {
    const a = {
      items: [
        { _key: "q1", q: "One?" },
        { _key: "q2", q: "Two?" },
      ],
    };
    const b = {
      items: [
        { _key: "q1", q: "First?" },
        { _key: "q3", q: "Three?" },
      ],
    };
    expect(diffFields(a, b, "").map((f) => [f.path, f.kind])).toEqual([
      ["items[q1].q", "changed"],
      ["items[q3]", "added"],
      ["items[q2]", "removed"],
    ]);
  });

  it("reports a reordered list without per-item noise, and added/removed fields", () => {
    const a = {
      items: [
        { _key: "x", t: "1" },
        { _key: "y", t: "2" },
      ],
      old: 1,
    };
    const b = {
      items: [
        { _key: "y", t: "2" },
        { _key: "x", t: "1" },
      ],
      fresh: "yes",
    };
    expect(diffFields(a, b, "").map((f) => [f.path, f.kind])).toEqual([
      ["items", "changed"],
      ["old", "removed"],
      ["fresh", "added"],
    ]);
  });

  it("treats rich text as one field with a word diff of its text", () => {
    const [change] = diffFields(
      { body: richTextFromString("It is good.") },
      { body: richTextFromString("It is great.") },
      ""
    );
    expect(change).toMatchObject({ path: "body", kind: "changed" });
    expect(change!.words).toEqual([
      { type: "same", text: "It is " },
      { type: "del", text: "good." },
      { type: "add", text: "great." },
    ]);
  });

  it("has no word diff when only rich-text formatting changed", () => {
    const plain = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
    };
    const bold = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hi", marks: [{ type: "bold" }] }],
        },
      ],
    };
    const [change] = diffFields({ body: plain }, { body: bold }, "");
    expect(change!.kind).toBe("changed");
    expect(change!.words).toBeUndefined();
    expect(change!.formatting).toBe(true);
    expect(
      diffFields({ body: plain }, { body: richTextFromString("Ho") }, "")[0]!
        .formatting
    ).toBeUndefined();
  });

  it("treats only real colours ({token} or {hex} alone) as leaves; other objects with those keys are walked", () => {
    expect(
      diffFields({ c: { token: "white" } }, { c: { hex: "#000" } }, "").map(
        (f) => [f.path, f.before, f.after]
      )
    ).toEqual([["c", { token: "white" }, { hex: "#000" }]]);
    expect(
      diffFields(
        { cfg: { token: "a", label: "x" } },
        { cfg: { token: "a", label: "y" } },
        ""
      ).map((f) => f.path)
    ).toEqual(["cfg.label"]);
    expect(isColor({ token: "white" })).toBe(true);
    expect(isColor({ hex: "#fff" })).toBe(true);
    expect(isColor({ token: "a", label: "x" })).toBe(false);
  });
});

describe("wordDiff", () => {
  it("marks changed words and keeps the rest", () => {
    expect(wordDiff("The quick brown fox", "The slow brown fox jumps")).toEqual(
      [
        { type: "same", text: "The " },
        { type: "del", text: "quick" },
        { type: "add", text: "slow" },
        { type: "same", text: " brown fox" },
        { type: "add", text: " jumps" },
      ]
    );
  });

  it("groups a run of changed words into one deletion and one insertion", () => {
    expect(
      wordDiff(
        "The lead was rewritten for version B.",
        "The original lead from version A."
      )
    ).toEqual([
      { type: "same", text: "The " },
      { type: "del", text: "lead was rewritten for" },
      { type: "add", text: "original lead from" },
      { type: "same", text: " version " },
      { type: "del", text: "B." },
      { type: "add", text: "A." },
    ]);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "new text")).toEqual([
      { type: "add", text: "new text" },
    ]);
    expect(wordDiff("old", "")).toEqual([{ type: "del", text: "old" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("falls back to replace-all for very long texts", () => {
    const long = (w: string) =>
      Array.from({ length: 600 }, (_, i) => `${w}${i}`).join(" ");
    expect(wordDiff(long("a"), long("b")).map((p) => p.type)).toEqual([
      "del",
      "add",
    ]);
  });
});

describe("richTextToPlain", () => {
  it("joins text nodes and puts block nodes on their own lines", () => {
    const rt = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "It is " },
            { type: "text", text: "great", marks: [{ type: "bold" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(richTextToPlain(rt)).toBe("Title\nIt is great\nOne");
  });
});
