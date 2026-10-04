// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import { applyOps } from "../ops/apply-ops";
import { sampleDoc } from "../test-fixtures";
import type { Op, PageDoc } from "../types";
import { validatePageDoc } from "../validate";
import {
  conflicts,
  groupsOf,
  opsToApply,
  proposedDoc,
  seoOpFor,
} from "./changeset";
import { stageOps, stageSeo } from "./stage";
import type { AgentErrorCode } from "./types";

let n = 0;
const genKey = () => `new${++n}`;

describe("stageOps", () => {
  it("stages a hero rewrite and a new rich-text block with Markdown, filling keys and default style", () => {
    const base = sampleDoc();
    const res = stageOps(
      base,
      [
        {
          op: "update",
          key: "hero1",
          props: {
            heading: "AI that pays for itself",
            lead: "For CFOs who want numbers, not hype.",
          },
        },
        {
          op: "insert",
          at: { after: "hero1" },
          block: {
            _type: "richText",
            props: { body: "## Why now\n\n- **Faster** close\n- Fewer errors" },
          },
        },
      ],
      { genKey }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    const inserted = res.ops[1];
    // A clone: bun's toMatchObject writes asymmetric matchers into the object it checks, and the doc below shares this block.
    expect(structuredClone(inserted)).toMatchObject({
      op: "insert",
      block: { _key: expect.stringMatching(/^new/), _type: "richText", _v: 1 },
    });
    const block = res.doc.blocks[1]!;
    expect(block._type).toBe("richText");
    // Markdown became the restricted rich-text JSON.
    expect(
      (block.props as { body: { content: unknown[] } }).body.content[0]
    ).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Why now" }],
    });
    // The type's default style was copied in, as the editor's "+" does.
    expect(block.style?.maxWidth).toEqual({ desktop: "narrow" });
    expect(validatePageDoc(res.doc).ok).toBe(true);
    // The draft itself is untouched.
    expect(base.blocks).toHaveLength(sampleDoc().blocks.length);
  });

  it("rich text in list items of an update is converted too", () => {
    const res = stageOps(sampleDoc(), [
      {
        op: "update",
        key: "grid1",
        props: {
          items: [
            { _key: "a", title: "One", body: "Now *with* a [link](/contact)." },
          ],
        },
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    const items = (
      res.doc.blocks.find((b) => b._key === "grid1")!.props as {
        items: { body: unknown }[];
      }
    ).items;
    expect(items[0]!.body).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Now " },
            { type: "text", text: "with", marks: [{ type: "italic" }] },
            { type: "text", text: " a " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "/contact" } }],
            },
            { type: "text", text: "." },
          ],
        },
      ],
    });
  });

  it.each([
    [
      "INVALID_PROPS",
      [{ op: "update", key: "hero1", props: { heading: "" } }],
      /block "hero1"\.props\.heading/,
    ],
    [
      "INVALID_STYLE",
      [
        {
          op: "update",
          key: "hero1",
          style: { padding: { mobile: { top: 9999 } } },
        },
      ],
      /block "hero1"\.style/,
    ],
    [
      "INVALID_STYLE",
      [
        {
          op: "update",
          key: "hero1",
          style: { elements: { nope: { color: { token: "white" } } } },
        },
      ],
      /elements/,
    ],
    [
      "UNKNOWN_BLOCK",
      [{ op: "insert", block: { _type: "carousel", props: {} } }],
      /ops\[0\]\.block\._type/,
    ],
    [
      "UNKNOWN_KEY",
      [{ op: "update", key: "missing", props: { heading: "x" } }],
      /ops\[0\]/,
    ],
    [
      "BAD_POSITION",
      [{ op: "move", key: "hero1", to: { index: 99 } }],
      /ops\[0\]/,
    ],
    ["INVALID_OPS", [{ op: "explode", key: "hero1" }], /ops\[0\]/],
    ["NOT_ALLOWED", [{ op: "setSeo", seo: { title: "x" } }], /ops\[0\]/],
  ])("returns %s with a path", (code, ops, path) => {
    const res = stageOps(sampleDoc(), ops);
    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.errors[0]!.code).toBe(code as AgentErrorCode);
    expect(`${res.errors[0]!.path} ${res.errors[0]!.message}`).toMatch(path);
  });

  it("refuses ops that change nothing", () => {
    const res = stageOps(sampleDoc(), [
      { op: "update", key: "hero1", props: { heading: "Hello CMS" } },
    ]);
    expect(res).toMatchObject({ ok: false, errors: [{ code: "INVALID_OPS" }] });
  });

  it("ignores problems in blocks it didn't touch", () => {
    const base = sampleDoc();
    base.blocks.push({
      _key: "broken",
      _type: "hero",
      _v: 1,
      props: { variant: "page" },
    });
    expect(
      stageOps(base, [
        { op: "update", key: "hero1", props: { heading: "Changed" } },
      ]).ok
    ).toBe(true);
  });

  it("warns (LOW_CONTRAST) about a failing solid colour pair, without refusing it", () => {
    const res = stageOps(sampleDoc(), [
      {
        op: "update",
        key: "hero1",
        style: {
          background: { color: { token: "white" } },
          colors: { text: { token: "primary-soft" } },
        },
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    // The new text colour fails, and so does the cyan heading the block already had.
    expect(
      res.warnings.map((w) => [w.code, w.key, w.message.split(" on ")[0]])
    ).toEqual([
      ["LOW_CONTRAST", "hero1", "Text colour"],
      ["LOW_CONTRAST", "hero1", "Heading colour"],
    ]);
  });

  it("stages mobile-only style ops", () => {
    const res = stageOps(sampleDoc(), [
      {
        op: "update",
        key: "hero1",
        style: {
          padding: { mobile: { top: 64, bottom: 64 } },
          colors: { accent: { token: "accent" } },
        },
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.doc.blocks[0]!.style?.padding).toEqual({
      mobile: { top: 64, bottom: 64 },
    });
  });
});

describe("stageSeo", () => {
  const proposal = {
    seo: {
      focusKeyphrase: "ai consulting sydney",
      social: {
        title: "AI consulting",
        description: "Teams that use AI well.",
      },
      llms: { summary: "AI consulting." },
    },
    variants: [
      {
        title: "AI Consulting in Sydney",
        description: "Practical AI adoption for growing teams.",
      },
      {
        title: "AI Transformation Consulting",
        description: "Make your team AI-native.",
      },
    ],
  };

  it("validates every variant", () => {
    const res = stageSeo(sampleDoc(), proposal);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.seo.title).toBe("AI Consulting in Sydney");
    }
  });

  it("refuses a variant that breaks the SEO schema", () => {
    const res = stageSeo(sampleDoc(), {
      ...proposal,
      variants: [
        ...proposal.variants,
        { title: "x".repeat(201), description: "d" },
      ],
    });
    expect(res).toMatchObject({
      ok: false,
      errors: [
        { code: "INVALID_SEO", path: expect.stringContaining("variants[2]") },
      ],
    });
  });

  it("applies the chosen variant on accept", () => {
    const op = seoOpFor(proposal, proposal.variants[1]);
    const doc = applyOps(sampleDoc(), [op]).doc;
    expect(doc.seo).toMatchObject({
      title: "AI Transformation Consulting",
      focusKeyphrase: "ai consulting sydney",
      social: { title: "AI consulting" },
    });
    expect(doc.seo.slug).toBe("services/sample");
  });
});

describe("reviewing a changeset", () => {
  function staged(base: PageDoc) {
    const res = stageOps(
      base,
      [
        { op: "update", key: "hero1", props: { heading: "New heading" } },
        {
          op: "insert",
          at: { after: "hero1" },
          block: { _key: "n1", _type: "richText", props: { body: "Intro" } },
        },
        {
          op: "insert",
          at: { after: "n1" },
          block: { _key: "n2", _type: "richText", props: { body: "More" } },
        },
        {
          op: "update",
          key: "grid1",
          style: { padding: { mobile: { top: 24 } } },
        },
      ],
      { genKey }
    );
    if (!res.ok) {
      throw new Error(JSON.stringify(res.errors));
    }
    return res;
  }

  it("groups ops per block", () => {
    expect(groupsOf(staged(sampleDoc()).ops)).toEqual([
      "hero1",
      "n1",
      "n2",
      "grid1",
    ]);
  });

  it("accepting everything gives the staged page", () => {
    const base = sampleDoc();
    const s = staged(base);
    const { ops, skipped } = opsToApply(
      base,
      s.ops,
      new Set(groupsOf(s.ops)),
      s.doc
    );
    expect(skipped).toEqual([]);
    expect(applyOps(base, ops).doc).toEqual(s.doc);
  });

  it("rejecting everything leaves the draft untouched", () => {
    const base = sampleDoc();
    const s = staged(base);
    const { ops } = opsToApply(base, s.ops, new Set(), s.doc);
    expect(ops).toEqual([]);
    expect(proposedDoc(base, s.ops, new Set())).toEqual(base);
  });

  it("accepting a subset re-anchors inserts whose anchor was rejected", () => {
    const base = sampleDoc();
    const s = staged(base);
    const { ops } = opsToApply(base, s.ops, new Set(["n2", "grid1"]), s.doc);
    const doc = applyOps(base, ops).doc;
    expect(doc.blocks.map((b) => b._key)).toEqual([
      "hero1",
      "n2",
      ...base.blocks.slice(1).map((b) => b._key),
    ]);
    expect((doc.blocks[0]!.props as { heading: string }).heading).toBe(
      "Hello CMS"
    );
  });

  it("flags blocks the user changed or deleted after the proposal, and skips ops on deleted ones", () => {
    const base = sampleDoc();
    const s = staged(base);
    const current = applyOps(base, [
      { op: "update", key: "hero1", props: { lead: "My own edit" } },
      { op: "remove", key: "grid1" },
    ] as Op[]).doc;
    expect(conflicts(base, current, s.ops)).toEqual([
      { group: "hero1", reason: "changed" },
      { group: "grid1", reason: "deleted" },
    ]);
    const { ops, skipped } = opsToApply(
      current,
      s.ops,
      new Set(groupsOf(s.ops)),
      s.doc
    );
    expect(skipped).toEqual(["grid1"]);
    const doc = applyOps(current, ops).doc;
    // The user's own edit and the agent's heading both survive (merge-patch on different props).
    expect(doc.blocks[0]!.props).toMatchObject({
      heading: "New heading",
      lead: "My own edit",
    });
  });
});
