// biome-ignore-all lint/complexity/noVoid: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import { MAX_PLAN_ITEMS } from "../agent/plan";
import {
  buildFixPrompt,
  type FixTarget,
  MAX_PROMPT_CHARS,
  PROMPT_QUERIES_PER_PAGE,
  stashFixPrompt,
  takeFixPrompt,
} from "./fix-prompt";

const target = (n: number, extra: Partial<FixTarget> = {}): FixTarget => ({
  pageId: `p${n}`,
  path: `/page-${n}`,
  title: `Page ${n}`,
  issues: [
    {
      id: "description-length",
      label: "Meta description",
      status: "warn",
      message: "No meta description.",
    },
  ],
  queries: [],
  ...extra,
});

const query = (i: number) => ({
  page: "https://example.com/page-1",
  query: `query number ${i}`,
  clicks: 1,
  impressions: 100 - i,
  position: 7.25,
});

describe("buildFixPrompt", () => {
  it("starts with a short title line and lists each page's findings", () => {
    const text = buildFixPrompt([
      target(1, { queries: [query(1)] }),
      target(2, {
        issues: [],
        notIndexed: {
          inspection: {
            page: "x",
            checkedAt: 0,
            verdict: "NEUTRAL",
            coverageState: "Crawled - currently not indexed",
            lastCrawl: "2026-09-30T01:02:03Z",
            googleCanonical: null,
            userCanonical: null,
          },
        },
      }),
    ]);
    const [head] = text.split("\n");
    expect(head).toBe("Fix SEO on 2 pages: /page-1, /page-2");
    expect(text).toContain("- [warn] Meta description: No meta description.");
    expect(text).toContain(
      "- “query number 1”: 99 impressions, 1 clicks, position 7.3"
    );
    expect(text).toContain(
      "Not indexed by Google: verdict NEUTRAL, “Crawled - currently not indexed”, last crawled 2026-09-30."
    );
    expect(text).toContain("site-wide plan");
  });

  it("keeps the title line within 80 characters", () => {
    const text = buildFixPrompt(
      Array.from({ length: MAX_PLAN_ITEMS }, (_, i) =>
        target(i, { path: `/services/a-rather-long-slug-${i}` })
      )
    );
    expect(text.split("\n")[0]!.length).toBeLessThanOrEqual(80);
  });

  it("caps queries per page and shrinks them to fit the message limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => query(i));
    expect(buildFixPrompt([target(1, { queries: many })])).toContain(
      `…and ${30 - PROMPT_QUERIES_PER_PAGE} more`
    );
    const long = Array.from({ length: MAX_PLAN_ITEMS }, (_, i) =>
      target(i, {
        queries: many.map((q) => ({
          ...q,
          query: `${q.query} ${"x".repeat(80)}`,
        })),
        issues: Array.from({ length: 6 }, () => target(0).issues[0]!),
      })
    );
    expect(buildFixPrompt(long).length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("refuses an empty selection and more pages than a run can hold", () => {
    expect(() => buildFixPrompt([])).toThrow();
    expect(() =>
      buildFixPrompt(
        Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => target(i))
      )
    ).toThrow();
  });
});

describe("fix prompt handoff", () => {
  it("can be taken once", () => {
    const store = new Map<string, string>();
    const storage = {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    const key = stashFixPrompt(storage, "hello");
    expect(takeFixPrompt(storage, key)).toBe("hello");
    expect(takeFixPrompt(storage, key)).toBeNull();
  });
});
