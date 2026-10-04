import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { TOKEN_CSS } from "@repo/cms-core/editor/style-model";
import { BRAND_TOKENS } from "@repo/cms-core/types";

const HEX_RE = /^#[0-9a-f]{3,8}$/i;

/** The body of src/styles.css's `@theme static { … }` block (Tailwind emits its vars even when unused). */
function themeStaticBlock(): string {
  const css = readFileSync(
    new URL("../../../styles.css", import.meta.url),
    "utf8"
  );
  const start = css.indexOf("@theme static {");
  if (start < 0) {
    return "";
  }
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(start, i + 1);
      }
    }
  }
  return "";
}

/** The value `--color-brand-<token>` is declared with inside `@theme static`, if it is. */
function declared(block: string, token: string): string | undefined {
  const match = new RegExp(`--color-brand-${token}\\s*:\\s*([^;]+);`).exec(
    block
  );
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null when the token isn't declared.
  return match ? match[1]?.trim() : undefined;
}

describe("CMS colour tokens", () => {
  const block = themeStaticBlock();

  // The CMS writes var(--color-brand-<token>) inline, where Tailwind can't see it, so the variables
  // must come from `@theme static` to be in the built CSS.
  it("declares every BRAND_TOKENS colour inside @theme static in src/styles.css", () => {
    expect(block).not.toBe("");
    const missing = BRAND_TOKENS.filter(
      (token) => declared(block, token) === undefined
    );
    expect(missing).toEqual([]);
  });

  // The editor's contrast check rates colours by TOKEN_CSS. Every token is a hex literal in
  // `@theme static` (--color-brand-*, never an alias of a shadcn variable) and must equal it.
  it("TOKEN_CSS matches every token in @theme static", () => {
    const literals = BRAND_TOKENS.flatMap((token) => {
      const value = declared(block, token);
      return value && HEX_RE.test(value) ? [[token, value] as const] : [];
    });
    expect(literals.length).toBe(BRAND_TOKENS.length);
    for (const [token, value] of literals) {
      expect(value.toLowerCase(), token).toBe(TOKEN_CSS[token].toLowerCase());
    }
  });
});
