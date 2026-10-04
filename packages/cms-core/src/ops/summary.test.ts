import { describe, expect, it } from "bun:test";
import { summarizeChange } from "./summary";
import { block, doc, post, seo } from "./test-docs";

const labels: Record<string, string> = {
  hero: "Hero",
  faq: "FAQ",
  testimonial: "Testimonial",
  cta: "CTA",
  stats: "Stats",
};
const labelFor = (t: string) => labels[t] ?? t;

const hero = (heading: string, top: number) =>
  block(
    "h",
    "hero",
    { heading, sub: "S" },
    { style: { padding: { mobile: { top } } } }
  );

describe("summarizeChange", () => {
  it("summarizes edits, style, additions, removals and SEO in one line", () => {
    const prev = doc([
      hero("Old", 48),
      block("t", "testimonial", { quote: "Q" }),
    ]);
    const next = doc(
      [hero("New", 32), block("f", "faq", { items: [1, 2, 3, 4] })],
      { seo: seo({ title: "New title" }) }
    );
    expect(summarizeChange(prev, next, labelFor)).toBe(
      "Edited Hero heading · mobile padding top 48→32 · added FAQ (4 items) · removed Testimonial · SEO title changed"
    );
  });

  it("labels a style-only change with the block", () => {
    expect(
      summarizeChange(doc([hero("A", 48)]), doc([hero("A", 32)]), labelFor)
    ).toBe("Hero mobile padding top 48→32");
  });

  it("describes colours, set and reset values", () => {
    const a = block(
      "c",
      "cta",
      {},
      {
        style: {
          elements: { heading: { color: { token: "primary-soft" } } },
          border: "glow",
        },
      }
    );
    const b = block(
      "c",
      "cta",
      {},
      {
        style: {
          elements: { heading: { color: { token: "white" } } },
          gap: { desktop: 24 },
        },
      }
    );
    expect(summarizeChange(doc([a]), doc([b]), labelFor)).toBe(
      "CTA heading color primary-soft→white · border reset · desktop gap 24"
    );
  });

  it("reports reorders, replaced types and post changes", () => {
    const prev = doc([block("a", "cta"), block("b", "stats")], {
      post: post(),
    });
    const next = doc([block("b", "stats"), block("a", "hero")], {
      post: post({ tags: ["x"], excerpt: "New" }),
    });
    expect(summarizeChange(prev, next, labelFor)).toBe(
      "Replaced CTA with Hero · reordered blocks · post excerpt, tags changed"
    );
  });

  it("caps the number of parts", () => {
    const next = doc(
      Array.from({ length: 8 }, (_, i) => block(`b${i}`, "stats"))
    );
    expect(summarizeChange(doc([]), next, labelFor)).toBe(
      "Added Stats · added Stats · added Stats · added Stats · added Stats · added Stats · +2 more"
    );
  });

  it("says when nothing changed", () => {
    expect(summarizeChange(doc(), doc(), labelFor)).toBe("No changes");
  });
});
