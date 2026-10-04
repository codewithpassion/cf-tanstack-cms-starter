import { describe, expect, it } from "bun:test";

import {
  MAX_PLAN_ITEMS,
  type PlanItemInput,
  type PlanPage,
  validatePlan,
} from "./plan";

const pages: PlanPage[] = [
  { slug: "", kind: "page", status: "published" },
  { slug: "preview-e2e-test", kind: "page", status: "draft" },
  { slug: "services/automation-sprint", kind: "page", status: "published" },
  { slug: "blog/first-post", kind: "post", status: "published" },
  { slug: "old-page", kind: "page", status: "archived" },
];

const check = (items: PlanItemInput[]) => validatePlan(items, pages);
const codes = (items: PlanItemInput[]) => {
  const res = check(items);
  return res.ok ? [] : res.errors.map((e) => `${e.path}:${e.code}`);
};

describe("validatePlan", () => {
  it("accepts a mixed plan and normalises slugs and intents", () => {
    const res = check([
      {
        slug: "/preview-e2e-test/",
        action: "edit",
        intent: "  Tighten the hero.  ",
      },
      {
        slug: "services/automation-sprint",
        action: "seo",
        intent: "Do the SEO.",
      },
      {
        slug: "ai-consulting-perth",
        action: "duplicate",
        from: "/preview-e2e-test",
        intent: "Perth version.",
      },
      {
        slug: "ai-consulting-adelaide",
        action: "create",
        intent: "Adelaide page.",
      },
      { slug: "blog/new-post", action: "create", intent: "A post." },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.items[0]).toEqual({
      slug: "preview-e2e-test",
      action: "edit",
      intent: "Tighten the hero.",
    });
    expect(res.items[2]).toEqual({
      slug: "ai-consulting-perth",
      action: "duplicate",
      intent: "Perth version.",
      from: "preview-e2e-test",
    });
  });

  it("edit and seo need an existing, non-archived CMS page", () => {
    expect(codes([{ slug: "about", action: "edit", intent: "x" }])).toEqual([
      "items[0].slug:NOT_FOUND",
    ]);
    expect(codes([{ slug: "old-page", action: "seo", intent: "x" }])).toEqual([
      "items[0].slug:NOT_FOUND",
    ]);
    expect(codes([{ slug: "", action: "edit", intent: "Home hero" }])).toEqual(
      []
    );
  });

  it("new pages can't take reserved, taken or malformed slugs", () => {
    expect(
      codes([{ slug: "admin/perth", action: "create", intent: "x" }])
    ).toEqual(["items[0].slug:SLUG_RESERVED"]);
    expect(codes([{ slug: "login", action: "create", intent: "x" }])).toEqual([
      "items[0].slug:SLUG_RESERVED",
    ]);
    expect(
      codes([{ slug: "preview-e2e-test", action: "create", intent: "x" }])
    ).toEqual(["items[0].slug:SLUG_TAKEN"]);
    expect(
      codes([{ slug: "Perth Page", action: "create", intent: "x" }])
    ).toEqual(["items[0].slug:INVALID_SLUG"]);
    expect(codes([{ slug: "", action: "create", intent: "x" }])).toEqual([
      "items[0].slug:SLUG_RESERVED",
    ]);
    expect(
      codes([{ slug: "blog/a/b", action: "create", intent: "x" }])
    ).toEqual(["items[0].slug:INVALID_SLUG"]);
    // An archived page frees its slug.
    expect(
      codes([{ slug: "old-page", action: "create", intent: "x" }])
    ).toEqual([]);
  });

  it("duplicate needs a source of the same kind", () => {
    expect(codes([{ slug: "copy", action: "duplicate", intent: "x" }])).toEqual(
      ["items[0].from:NOT_FOUND"]
    );
    expect(
      codes([{ slug: "copy", action: "duplicate", from: "nope", intent: "x" }])
    ).toEqual(["items[0].from:NOT_FOUND"]);
    expect(
      codes([
        {
          slug: "post-copy",
          action: "duplicate",
          from: "blog/first-post",
          intent: "x",
        },
      ])
    ).toEqual(["items[0].slug:INVALID_SLUG"]);
    expect(
      codes([
        {
          slug: "blog/post-copy",
          action: "duplicate",
          from: "blog/first-post",
          intent: "x",
        },
      ])
    ).toEqual([]);
    expect(
      codes([
        {
          slug: "blog/page-copy",
          action: "duplicate",
          from: "preview-e2e-test",
          intent: "x",
        },
      ])
    ).toEqual(["items[0].slug:INVALID_SLUG"]);
  });

  it("one item per page, a non-empty intent, and a size limit", () => {
    expect(
      codes([
        { slug: "a-page", action: "create", intent: "x" },
        { slug: "/a-page", action: "create", intent: "y" },
      ])
    ).toEqual(["items[1].slug:INVALID_INPUT"]);
    expect(
      codes([{ slug: "a-page", action: "create", intent: "   " }])
    ).toEqual(["items[0].intent:INVALID_INPUT"]);
    expect(codes([])).toEqual(["items:INVALID_INPUT"]);
    const many = Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => ({
      slug: `p-${i}`,
      action: "create" as const,
      intent: "x",
    }));
    expect(codes(many)).toEqual(["items:INVALID_INPUT"]);
  });
});
