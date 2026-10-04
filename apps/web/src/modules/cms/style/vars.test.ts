import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createBlock } from "@repo/cms-core/blocks/registry";
import { applyOps } from "@repo/cms-core/ops/apply-ops";
import { nth } from "@repo/cms-core/ops/test-docs";
import {
  computeElementVars,
  computeStyleVars,
  mergeStyle,
} from "@repo/cms-core/style/vars";
import { blockDef, sampleSeo } from "@repo/cms-core/test-fixtures";
import type {
  BlockStyle,
  Device,
  ElementStyle,
  PageDoc,
} from "@repo/cms-core/types";

// The cms.css half of the source's style/vars.test.ts: cms-core tests the vars and attributes
// (style/vars.test.ts); these run them through the real var() chains in this app's cms.css.

const WHITESPACE_RE = /\s/;
const ATTR_SELECTOR_RE = /^\[([\w-]+)(?:(~?=)"([^"]*)")?\]$/;
const VAR_CALL_RE = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/;

const cmsCss = readFileSync(new URL("./cms.css", import.meta.url), "utf8");

// --- A tiny evaluator for cms.css, so the tests exercise the real var() chains ---

type Rule = {
  media: string | null;
  selector: string;
  decls: Record<string, string>;
};

function parseCss(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let media: string | null = null;
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    const close = src.indexOf("}", i);
    if (open < 0) {
      break;
    }
    if (close >= 0 && close < open) {
      media = null; // end of an @media block
      i = close + 1;
      continue;
    }
    const head = src.slice(i, open).trim();
    if (head.startsWith("@media")) {
      media = head.slice("@media".length).trim();
      i = open + 1;
      continue;
    }
    const end = src.indexOf("}", open);
    const decls: Record<string, string> = {};
    for (const decl of src.slice(open + 1, end).split(";")) {
      const colon = decl.indexOf(":");
      if (colon > 0) {
        decls[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
      }
    }
    for (const selector of head.split(",")) {
      rules.push({ media, selector: selector.trim(), decls });
    }
    i = end + 1;
  }
  return rules;
}

const MEDIA: Record<string, Device[]> = {
  "(width < 1024px)": ["tablet", "mobile"],
  "(width < 768px)": ["mobile"],
  "(width >= 1024px)": ["desktop"],
  "(768px <= width < 1024px)": ["tablet"],
};

type El = { classes?: string[]; attrs?: Record<string, string>; vars?: object };

/** Supports compound selectors of `.class`, `[attr]`, `[attr="v"]`, `[attr~="v"]` (no combinators). */
function matches(selector: string, el: El): boolean {
  if (WHITESPACE_RE.test(selector)) {
    return false;
  }
  const parts = selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
  if (parts.join("") !== selector) {
    return false;
  }
  return parts.every((part) => {
    if (part.startsWith(".")) {
      return el.classes?.includes(part.slice(1)) ?? false;
    }
    const m = ATTR_SELECTOR_RE.exec(part);
    if (!m) {
      return false;
    }
    const [, name = "", op, expected = ""] = m;
    const value = el.attrs?.[name];
    if (value === undefined) {
      return false;
    }
    if (!op) {
      return true;
    }
    return op === "="
      ? value === expected
      : value.split(" ").includes(expected);
  });
}

function evaluate(value: string, vars: object): string {
  const m = VAR_CALL_RE.exec(value.trim());
  if (!m) {
    return value.trim();
  }
  const [, name = "", fallback] = m;
  const set = (vars as Record<string, unknown>)[name];
  if (typeof set === "string") {
    return set;
  }
  if (fallback === undefined) {
    return "<invalid>";
  }
  return evaluate(fallback, vars);
}

const RULES = parseCss(cmsCss);

/** Computed value of `prop` for `el` at `device`, or undefined when no cms.css rule applies. */
function computed(el: El, prop: string, device: Device): string | undefined {
  let value: string | undefined;
  for (const rule of RULES) {
    if (rule.media !== null) {
      const devices = MEDIA[rule.media];
      if (!devices) {
        throw new Error(`Unknown media query in cms.css: ${rule.media}`);
      }
      if (!devices.includes(device)) {
        continue;
      }
    }
    if (prop in rule.decls && matches(rule.selector, el)) {
      value = rule.decls[prop];
    }
  }
  return value === undefined ? undefined : evaluate(value, el.vars ?? {});
}

function block(
  defaultStyle: BlockStyle | undefined,
  userStyle: BlockStyle | undefined
): El {
  const { style, attrs } = computeStyleVars(defaultStyle, userStyle);
  return { classes: ["cms-block"], attrs, vars: style };
}

const inner = (b: El): El => ({ classes: ["cms-inner"], vars: b.vars });
const element = (
  style: ElementStyle | undefined,
  inherited: object = {}
): El => {
  const { style: vars, attrs } = computeElementVars(style);
  return { attrs, vars: { ...inherited, ...vars } };
};

const DEVICES: Device[] = ["desktop", "tablet", "mobile"];
const at = (el: El, prop: string) =>
  Object.fromEntries(DEVICES.map((d) => [d, computed(el, prop, d)]));

describe("cms.css", () => {
  // Only the --cms-* chains: a block or element may leave any of them unset. Theme colours
  // (var(--color-primary)) are always declared by styles.css `@theme`.
  it("ends every var(--cms-*) chain in a literal", () => {
    const src = cmsCss.replace(/\/\*[\s\S]*?\*\//g, "");
    let count = 0;
    for (
      let i = src.indexOf("var(--cms-");
      i >= 0;
      i = src.indexOf("var(--cms-", i + 1)
    ) {
      let depth = 0;
      let comma = -1;
      let end = -1;
      for (let j = i + 3; j < src.length; j += 1) {
        if (src[j] === "(") {
          depth += 1;
        } else if (src[j] === ")" && depth === 1) {
          end = j;
          break;
        } else if (src[j] === ")") {
          depth -= 1;
        } else if (src[j] === "," && depth === 1 && comma < 0) {
          comma = j;
        }
      }
      const expr = src.slice(i, end + 1);
      expect(comma, `${expr} has no fallback`).toBeGreaterThan(0);
      expect(
        src.slice(comma + 1, end).trim(),
        `${expr} has an empty fallback`
      ).not.toBe("");
      count += 1;
    }
    expect(count).toBeGreaterThan(40);
  });

  it("uses only the three known breakpoints", () => {
    for (const rule of RULES) {
      if (rule.media) {
        expect(Object.keys(MEDIA)).toContain(rule.media);
      }
    }
  });
});

describe("block style inheritance", () => {
  it("nothing set → literal defaults, never invalid", () => {
    const b = block(undefined, undefined);
    expect(at(b, "padding-top")).toEqual({
      desktop: "0px",
      tablet: "0px",
      mobile: "0px",
    });
    expect(at(b, "margin-bottom")).toEqual({
      desktop: "0px",
      tablet: "0px",
      mobile: "0px",
    });
    expect(at(b, "background-color")).toEqual({
      desktop: "transparent",
      tablet: "transparent",
      mobile: "transparent",
    });
    expect(at(inner(b), "padding-inline")).toEqual({
      desktop: "32px",
      tablet: "24px",
      mobile: "16px",
    });
    expect(at(inner(b), "max-width")).toEqual({
      desktop: "1280px",
      tablet: "1280px",
      mobile: "1280px",
    });
    expect(at(inner(b), "text-align")).toEqual({
      desktop: "left",
      tablet: "left",
      mobile: "left",
    });
    expect(at({ classes: ["cms-gap"], vars: b.vars }, "gap")).toEqual({
      desktop: "24px",
      tablet: "24px",
      mobile: "24px",
    });
    expect(b.attrs).toEqual({});
  });

  it("mobile inherits tablet, tablet inherits desktop", () => {
    const b = block(undefined, {
      padding: { desktop: { top: 100 }, tablet: { top: 50 } },
    });
    expect(at(b, "padding-top")).toEqual({
      desktop: "100px",
      tablet: "50px",
      mobile: "50px",
    });

    const d = block(undefined, { padding: { desktop: { top: 100 } } });
    expect(at(d, "padding-top")).toEqual({
      desktop: "100px",
      tablet: "100px",
      mobile: "100px",
    });
  });

  it("maps max width, align and gap", () => {
    const b = block(
      { maxWidth: { desktop: "default" } },
      {
        maxWidth: { mobile: "full" },
        align: { desktop: "center", mobile: "left" },
        gap: { tablet: 8 },
      }
    );
    expect(at(inner(b), "max-width")).toEqual({
      desktop: "1280px",
      tablet: "1280px",
      mobile: "none",
    });
    expect(at(inner(b), "text-align")).toEqual({
      desktop: "center",
      tablet: "center",
      mobile: "left",
    });
    const measure = { classes: ["cms-measure"], vars: b.vars };
    expect(at(measure, "margin-left")).toEqual({
      desktop: "auto",
      tablet: "auto",
      mobile: "0px",
    });
    expect(at({ classes: ["cms-gap"], vars: b.vars }, "gap")).toEqual({
      desktop: "24px",
      tablet: "8px",
      mobile: "8px",
    });
  });
});

describe("Webflow model: block value per property, default only when unset", () => {
  const defaults: BlockStyle = {
    padding: { desktop: { top: 128, bottom: 80 }, mobile: { top: 96 } },
  };

  it("(a) a user desktop value cascades down and ignores the default for that property", () => {
    const b = block(defaults, { padding: { desktop: { top: 200 } } });
    expect(at(b, "padding-top")).toEqual({
      desktop: "200px",
      tablet: "200px",
      mobile: "200px",
    });
    // padding.bottom is a separate property, still unset by the user.
    expect(at(b, "padding-bottom")).toEqual({
      desktop: "80px",
      tablet: "80px",
      mobile: "80px",
    });
  });

  it("(b) createBlock copies the default; an explicit smaller-device value persists, and resetting it inherits again", () => {
    const def = blockDef("cta");
    expect(def.defaultStyle?.padding).toMatchObject({
      desktop: { top: 128 },
      mobile: { top: 96 },
    });
    const doc: PageDoc = {
      _schema: 1,
      seo: sampleSeo(),
      blocks: [createBlock("cta", { _key: "c" })],
    };
    const pt = (d: PageDoc) =>
      at(block(def.defaultStyle, nth(d.blocks, 0).style), "padding-top");

    const changed = applyOps(doc, [
      { op: "update", key: "c", style: { padding: { desktop: { top: 200 } } } },
    ]).doc;
    expect(pt(changed)).toEqual({
      desktop: "200px",
      tablet: "200px",
      mobile: "96px",
    });

    const reset = applyOps(changed, [
      { op: "update", key: "c", style: { padding: { mobile: { top: null } } } },
    ]).doc;
    expect(nth(reset.blocks, 0).style?.padding?.mobile).toEqual({ bottom: 96 });
    expect(pt(reset)).toEqual({
      desktop: "200px",
      tablet: "200px",
      mobile: "200px",
    });
  });

  it("(c) a property unset on every device falls back to the default's cascade", () => {
    const b = block(defaults, {
      padding: { tablet: { bottom: 40 } },
      gap: { desktop: 8 },
    });
    expect(at(b, "padding-top")).toEqual({
      desktop: "128px",
      tablet: "128px",
      mobile: "96px",
    });
    expect(at(b, "padding-bottom")).toEqual({
      desktop: "0px",
      tablet: "40px",
      mobile: "40px",
    });
    expect(at(block(defaults, undefined), "padding-top")).toEqual({
      desktop: "128px",
      tablet: "128px",
      mobile: "96px",
    });
  });

  it("(d) hide cascades down; an explicit false un-hides a smaller device", () => {
    const all = block(undefined, { hide: { desktop: true } });
    expect(all.attrs).toEqual({
      "data-cms-hide-d": "",
      "data-cms-hide-t": "",
      "data-cms-hide-m": "",
    });
    expect(at(all, "display")).toEqual({
      desktop: "none",
      tablet: "none",
      mobile: "none",
    });

    const notMobile = block(undefined, {
      hide: { desktop: true, mobile: false },
    });
    expect(at(notMobile, "display")).toEqual({
      desktop: "none",
      tablet: "none",
      mobile: undefined,
    });

    // The user's hide replaces the default's as a whole.
    const override = block(
      { hide: { tablet: true } },
      { hide: { mobile: false } }
    );
    expect(override.attrs).toEqual({});
    expect(at(block({ hide: { tablet: true } }, {}), "display")).toEqual({
      desktop: undefined,
      tablet: "none",
      mobile: "none",
    });
  });

  it("(e) element styles follow the same rules", () => {
    const base: BlockStyle = {
      elements: {
        heading: {
          size: { desktop: "xl", mobile: "base" },
          color: { token: "white" },
        },
      },
    };
    const set = mergeStyle(base, {
      elements: { heading: { size: { desktop: "2xl" } } },
    }).elements?.heading;
    expect(set).toEqual({
      size: { desktop: "2xl" },
      color: { token: "white" },
      align: undefined,
      hide: undefined,
    });
    expect(at(element(set), "font-size")).toEqual({
      desktop: "3.75rem",
      tablet: "3.75rem",
      mobile: "3.75rem",
    });

    const unset = mergeStyle(base, {
      elements: { heading: { align: { mobile: "center" } } },
    }).elements?.heading;
    expect(at(element(unset), "font-size")).toEqual({
      desktop: "2.25rem",
      tablet: "2.25rem",
      mobile: "1rem",
    });

    const hidden = element({ hide: { tablet: true } });
    expect(at(hidden, "display")).toEqual({
      desktop: undefined,
      tablet: "none",
      mobile: "none",
    });
  });

  it("createBlock materialises defaults as a copy and layers overrides with merge-patch", () => {
    const def = blockDef("hero");
    const b = createBlock("hero", {
      props: { heading: "Hi" },
      style: { padding: { mobile: { top: 40 } }, align: null },
    });
    expect(b).toEqual({
      _type: "hero",
      _v: def.version,
      props: { ...def.defaults(), heading: "Hi" },
      style: {
        padding: { desktop: { top: 128, bottom: 80 }, mobile: { top: 40 } },
      },
    });
    const desktop = b.style?.padding?.desktop;
    if (!desktop) {
      throw new Error("expected a desktop padding");
    }
    desktop.top = 1;
    expect(def.defaultStyle?.padding?.desktop?.top).toBe(128);
    expect(createBlock("hero", { _key: "k" })._key).toBe("k");
  });
});

describe("element styles", () => {
  it("leaves an element alone when nothing is set (Tailwind classes win)", () => {
    const el = element(undefined);
    expect(el.attrs).toEqual({});
    expect(at(el, "font-size")).toEqual({
      desktop: undefined,
      tablet: undefined,
      mobile: undefined,
    });
  });

  it("applies a mobile-only size on mobile only", () => {
    const el = element({ size: { mobile: "sm" } });
    expect(el.attrs).toEqual({ "data-cms-fs": "m" });
    expect(at(el, "font-size")).toEqual({
      desktop: undefined,
      tablet: undefined,
      mobile: "0.875rem",
    });
  });

  it("inherits a desktop size down and ignores the block's inherited vars", () => {
    const blockVars = computeStyleVars(undefined, {
      align: { tablet: "right" },
    }).style;
    const el = element(
      { size: { desktop: "2xl", mobile: "lg" }, align: { desktop: "center" } },
      blockVars
    );
    expect(el.attrs).toMatchObject({
      "data-cms-fs": "d t m",
      "data-cms-ta": "d t m",
    });
    expect(at(el, "font-size")).toEqual({
      desktop: "3.75rem",
      tablet: "3.75rem",
      mobile: "1.5rem",
    });
    expect(at(el, "text-align")).toEqual({
      desktop: "center",
      tablet: "center",
      mobile: "center",
    });
  });
});
