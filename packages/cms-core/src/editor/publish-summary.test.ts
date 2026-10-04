import { describe, expect, it } from "bun:test";

import { block, doc } from "../ops/test-docs";
import { diffDocs } from "./diff";
import { publishCounts, publishSummary } from "./publish-summary";

describe("publishSummary", () => {
  it("says first publish when nothing is live", () => {
    expect(publishSummary(null, 3)).toBe("First publish: 3 blocks go live.");
    expect(publishSummary(null, 1)).toBe("First publish: 1 block goes live.");
  });

  it("says so when the draft equals the live page", () => {
    expect(publishSummary(diffDocs(doc(), doc()), 2)).toBe(
      "No changes from the live page."
    );
  });

  it("counts changed, added, removed and moved blocks, then SEO fields", () => {
    const live = doc([
      block("a", "hero", { heading: "Hi" }),
      block("b", "faq"),
      block("c", "cta"),
      block("d", "x"),
      block("e", "x"),
    ]);
    const base = live.seo;
    const draft = doc(
      [
        block("a", "hero", { heading: "Hello" }),
        block("n", "image"),
        block("c", "cta"),
        block("e", "x"),
        block("d", "x"),
      ],
      { seo: { ...base, title: "New title", description: "New description" } }
    );
    const diff = diffDocs(live, draft);
    expect(publishCounts(diff)).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      moved: 1,
      seo: 2,
      post: 0,
    });
    expect(publishSummary(diff, draft.blocks.length)).toBe(
      "4 blocks: 1 changed, 1 added, 1 removed, 1 moved · 2 SEO fields"
    );
  });

  it("reports only what changed", () => {
    const live = doc([block("a", "hero", { heading: "Hi" })]);
    expect(
      publishSummary(
        diffDocs(live, doc([block("a", "hero", { heading: "Yo" })])),
        1
      )
    ).toBe("1 block: 1 changed");
    const seoOnly = doc(live.blocks, { seo: { ...live.seo, title: "T" } });
    expect(publishSummary(diffDocs(live, seoOnly), 1)).toBe("1 SEO field");
  });
});
