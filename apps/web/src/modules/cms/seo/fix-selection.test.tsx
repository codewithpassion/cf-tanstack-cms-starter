// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import type { SeoGscOverview } from "@repo/cms-core/gsc/shape";
import type { SeoOverviewRow } from "@repo/cms-core/seo/overview-table";
import { fixableIssues, selectionTargets } from "./fix-selection";

const row = (id: string, path: string): SeoOverviewRow =>
  ({
    id,
    path,
    pageTitle: `Title ${id}`,
    issues: [
      {
        id: "description-length",
        label: "Meta description",
        status: "warn",
        message: "Missing.",
      },
      { id: "slug", label: "URL", status: "warn", message: "Too long." },
    ],
  }) as SeoOverviewRow;

const gsc = {
  striking: [
    {
      page: "https://example.com/a",
      pageId: "a",
      impressions: 50,
      queries: [
        {
          page: "https://example.com/a",
          query: "ai consulting",
          clicks: 0,
          impressions: 50,
          position: 9,
        },
      ],
    },
  ],
  notIndexed: [
    {
      pageId: "b",
      title: "B page",
      url: "https://example.com/b",
      inspection: null,
      pending: false,
    },
  ],
} as unknown as SeoGscOverview;

describe("selectionTargets", () => {
  it("keeps only what was picked, in pick order", () => {
    const selection = new Map([
      ["b", { issues: new Set<string>(), striking: false, notIndexed: true }],
      [
        "a",
        {
          issues: new Set(["description-length"]),
          striking: true,
          notIndexed: false,
        },
      ],
    ]);
    const targets = selectionTargets(
      selection,
      [row("a", "/a"), row("b", "/b")],
      gsc
    );
    expect(targets.map((t) => t.pageId)).toEqual(["b", "a"]);
    expect(targets[0]).toMatchObject({
      issues: [],
      queries: [],
      notIndexed: { inspection: null },
    });
    expect(targets[1]!.issues.map((i) => i.id)).toEqual(["description-length"]);
    expect(targets[1]!.queries).toHaveLength(1);
    expect(targets[1]!.notIndexed).toBeNull();
  });

  it("leaves out the checks the agent can't fix", () => {
    expect(fixableIssues(row("a", "/a")).map((i) => i.id)).toEqual([
      "description-length",
    ]);
  });
});
