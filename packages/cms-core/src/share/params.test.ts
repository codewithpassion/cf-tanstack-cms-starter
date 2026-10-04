import { describe, expect, it } from "bun:test";

import {
  ogSlugFromPath,
  parseShareParams,
  parseShareQuery,
  shareRenderQuery,
} from "./params";

const MEDIA = `${"a".repeat(64)}.jpg`;

describe("parseShareParams", () => {
  it("defaults to the hero template with no overrides, ignoring the token", () => {
    expect(parseShareParams({ t: "x.y" })).toEqual({
      ok: true,
      params: { template: "hero" },
    });
  });

  it("accepts each template with its overrides", () => {
    expect(
      parseShareParams({
        template: "card",
        eyebrow: " AI ",
        headline: "Ship it",
        bg: MEDIA,
        gradient: "accent-glow",
      })
    ).toEqual({
      ok: true,
      params: {
        template: "card",
        eyebrow: "AI",
        headline: "Ship it",
        bg: MEDIA,
        gradient: "accent-glow",
      },
    });
    expect(
      parseShareParams({
        template: "post",
        category: "Engineering",
        author: "Jane",
      })
    ).toMatchObject({ ok: true });
  });

  it("stringifies values the router parsed as numbers or booleans", () => {
    expect(parseShareParams({ headline: 2026, eyebrow: true })).toEqual({
      ok: true,
      params: { template: "hero", headline: "2026", eyebrow: "true" },
    });
  });

  it.each([
    [{ template: "evil" }, "template"],
    [{ foo: "1" }, "Unrecognized key"],
    [{ headline: "x".repeat(141) }, "headline"],
    [{ headline: "   " }, "headline"],
    [{ eyebrow: "x".repeat(61) }, "eyebrow"],
    [{ bg: "../../etc/passwd" }, "bg"],
    [{ bg: "https://evil.example/x.jpg" }, "bg"],
    [{ gradient: "rainbow" }, "gradient"],
    [{ headline: { nested: "object" } }, "headline: expected a string"],
    [{ headline: ["a", "b"] }, "headline: expected a string"],
  ])("rejects %j", (search, message) => {
    const result = parseShareParams(search as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(message);
    }
  });
});

describe("shareRenderQuery", () => {
  const TOKEN =
    "eyJzbHVnIjoiY21zLXRlc3QifQ.RaHadylH9TV67-tPqxF6Q9OrJhXW7-VE-7YxRkwIf5A";

  it("puts the token first and round-trips through the router's parser", () => {
    const params = {
      template: "card" as const,
      headline: "A & B = C?",
      gradient: "primary-glow" as const,
    };
    const query = shareRenderQuery(TOKEN, params);
    expect(query.startsWith(`t=${TOKEN}&`)).toBe(true);
    const search: Record<string, unknown> = parseShareQuery(query);
    expect(search.t).toBe(TOKEN);
    expect(parseShareParams(search)).toEqual({ ok: true, params });
  });

  // The gate and the loader both read the query with parseShareQuery, which JSON-parses values:
  // a plain URLSearchParams query would turn "1.50" into 1.5 and "null" into null.
  it.each([
    '"Quoted headline"',
    "1.50",
    "1e3",
    "null",
    "true",
    "2026",
    "-1",
    "[1]",
    '{"a":1}',
    "🚀 Launch day",
    "<b>x</b>",
    "fa",
    "nu",
  ])("round-trips the headline %j unchanged", (headline) => {
    const params = { template: "card" as const, headline, eyebrow: headline };
    const search: Record<string, unknown> = parseShareQuery(
      shareRenderQuery(TOKEN, params)
    );
    expect(search.t).toBe(TOKEN);
    expect(parseShareParams(search)).toEqual({ ok: true, params });
  });
});

describe("ogSlugFromPath", () => {
  it.each([
    ["/og-render", ""],
    ["/og-render/cms-test", "cms-test"],
    ["/og-render/services/automation-sprint", "services/automation-sprint"],
  ])("%s → %j", (path, slug) => {
    expect(ogSlugFromPath(path)).toBe(slug);
  });

  it.each([
    "/",
    "/cms-test",
    "/og-renderx/cms-test",
    "/og-render/../admin",
    "/og-render/Bad_Slug",
    "/og-render//x",
    "/og-render/a%2Fb",
  ])("rejects %s", (path) => {
    expect(ogSlugFromPath(path)).toBeNull();
  });
});
