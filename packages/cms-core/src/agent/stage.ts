// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
import { nanoid } from "nanoid";

import { getBlockDef } from "../blocks/registry";
import { isLargeSize, rateContrast } from "../editor/style-model";
import { applyOps, OpError } from "../ops/apply-ops";
import { deepEqual, isPlainObject, mergePatch } from "../ops/json";
import { parseOps } from "../ops/schema";
import { mergeStyle } from "../style/vars";
import type { Block, BlockStyle, Color, Op, PageDoc } from "../types";
import { pageLimitErrors, validatePageDoc } from "../validate";
import { propsFromAgent } from "./catalogue";
import { seoOpFor } from "./changeset";
import type {
  AgentErrorCode,
  AgentToolError,
  AgentWarning,
  SeoProposal,
} from "./types";

/**
 * Staging the agent's proposals: nothing here writes anything. `stageOps`
 * turns the agent's ops (rich text as Markdown, keys optional) into editor ops, applies them to a
 * copy of the draft and validates the result; `stageSeo` does the same for an SEO proposal. Errors
 * carry the stable codes the model is told about, with paths it can act on.
 */

export type StageOk = {
  ok: true;
  ops: Op[];
  doc: PageDoc;
  warnings: AgentWarning[];
};
export type StageFail = { ok: false; errors: AgentToolError[] };

const OP_ERROR_CODES: Record<string, AgentErrorCode> = {
  UNKNOWN_KEY: "UNKNOWN_KEY",
  DUPLICATE_KEY: "DUPLICATE_KEY",
  BAD_POSITION: "BAD_POSITION",
  UNKNOWN_OP: "INVALID_OPS",
  NO_POST: "NOT_ALLOWED",
};

type AgentBlock = {
  _key?: string;
  _type?: unknown;
  props?: unknown;
  style?: unknown;
};

/** Converts one agent op into an editor op against the working document (which knows block types). */
function convert(
  raw: unknown,
  i: number,
  doc: PageDoc,
  genKey: () => string
): { op: unknown } | { error: AgentToolError } {
  if (typeof raw !== "object" || raw === null) {
    return {
      error: {
        code: "INVALID_OPS",
        message: "An op must be an object",
        path: `ops[${i}]`,
      },
    };
  }
  const op = raw as Record<string, unknown>;
  if (op.op === "setSeo") {
    return {
      error: {
        code: "NOT_ALLOWED",
        message: "SEO changes go through propose_seo, not propose_ops",
        path: `ops[${i}]`,
      },
    };
  }
  if (op.op === "insert" || op.op === "replace") {
    const block = (op.block ?? {}) as AgentBlock;
    const type = typeof block._type === "string" ? block._type : "";
    const def = getBlockDef(type);
    if (!def) {
      return {
        error: {
          code: "UNKNOWN_BLOCK",
          message: `Unknown block type "${type}" (see list_block_types)`,
          path: `ops[${i}].block._type`,
        },
      };
    }
    const existing =
      op.op === "replace"
        ? doc.blocks.find((b) => b._key === op.key)
        : undefined;
    const key =
      op.op === "insert"
        ? typeof block._key === "string" && block._key
          ? block._key
          : genKey()
        : String(op.key ?? "");
    let style = block.style as BlockStyle | undefined;
    // New blocks start from the type's default style, as the editor's "+" does; the agent's style patches it.
    if (
      op.op === "insert" &&
      (block.style === undefined || isPlainObject(block.style))
    ) {
      style = mergePatch(
        structuredClone(def.defaultStyle ?? {}),
        (block.style ?? {}) as object
      ) as BlockStyle;
    } else if (op.op === "replace" && style === undefined) {
      style = existing?.style;
    }
    const next: Record<string, unknown> = {
      _key: key,
      _type: type,
      _v: def.version,
      props: propsFromAgent(def, block.props ?? {}),
    };
    if (
      style !== undefined &&
      (!isPlainObject(style) || Object.keys(style).length)
    ) {
      next.style = style;
    }
    // No position: the end of the page.
    return {
      op:
        op.op === "insert" && op.at === undefined
          ? { ...op, at: {}, block: next }
          : { ...op, block: next },
    };
  }
  if (op.op === "update" && op.props !== undefined) {
    const target = doc.blocks.find((b) => b._key === op.key);
    const def = target && getBlockDef(target._type);
    if (def) {
      return { op: { ...op, props: propsFromAgent(def, op.props) } };
    }
  }
  return { op };
}

/** Block keys an op sets content or style on. */
function touched(op: Op): string | null {
  if (op.op === "insert") {
    return op.block._key ?? null;
  }
  if (op.op === "update" || op.op === "replace") {
    return op.key;
  }
  return null;
}

/**
 * Stages agent ops on `base`. On success the ops are in the editor's format (keys filled in, rich
 * text as JSON) and `doc` is the page with them applied.
 */
export function stageOps(
  base: PageDoc,
  rawOps: unknown,
  opts: { genKey?: () => string } = {}
): StageOk | StageFail {
  const genKey = opts.genKey ?? (() => nanoid(8));
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return fail("INVALID_OPS", "ops must be a non-empty array", "ops");
  }
  let doc = base;
  const ops: Op[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const converted = convert(rawOps[i], i, doc, genKey);
    if ("error" in converted) {
      return { ok: false, errors: [converted.error] };
    }
    const parsed = parseOps([converted.op]);
    if (!parsed.ok) {
      return {
        ok: false,
        errors: parsed.errors.map((e) => ({
          code: "INVALID_OPS" as const,
          message: e.message,
          path: e.path.replace(/^ops\[0\]/, `ops[${i}]`),
        })),
      };
    }
    try {
      const res = applyOps(doc, parsed.ops);
      doc = res.doc;
      ops.push(...res.ops);
    } catch (err) {
      if (!(err instanceof OpError)) {
        throw err;
      }
      return fail(
        OP_ERROR_CODES[err.code] ?? "INVALID_OPS",
        err.message.replace(/^op 0: /, ""),
        `ops[${i}]`
      );
    }
  }
  if (deepEqual(doc, base)) {
    return fail("INVALID_OPS", "These ops change nothing on the page", "ops");
  }

  const keys = new Set(ops.map(touched).filter((k): k is string => k !== null));
  const touchesPost = ops.some((op) => op.op === "setPost");
  const errors = validationErrors(doc, keys, touchesPost);
  if (errors.length) {
    return { ok: false, errors };
  }
  return { ok: true, ops, doc, warnings: contrastWarnings(doc, keys) };
}

/** Validation errors of the staged page, limited to what the ops touched (an old problem elsewhere isn't the agent's). */
function validationErrors(
  doc: PageDoc,
  keys: Set<string>,
  touchesPost: boolean
): AgentToolError[] {
  const errors: AgentToolError[] = pageLimitErrors(doc, {
    post: touchesPost,
  }).map((e) => ({ code: "INVALID_OPS", message: e.message, path: e.path }));
  const result = validatePageDoc(doc);
  if (result.ok) {
    return errors;
  }
  for (const e of result.errors) {
    const m = /^blocks\[(\d+)\](.*)$/.exec(e.path);
    if (m) {
      const block = doc.blocks[Number(m[1])] as Block | undefined;
      if (!(block && keys.has(block._key))) {
        continue;
      }
      const rest = m[2]!;
      const code: AgentErrorCode = rest.startsWith(".style")
        ? "INVALID_STYLE"
        : rest === "._type"
          ? "UNKNOWN_BLOCK"
          : "INVALID_PROPS";
      errors.push({
        code,
        message: e.message,
        path: `block "${block._key}"${rest}`,
      });
    } else if (e.path.startsWith("post") && touchesPost) {
      errors.push({ code: "INVALID_OPS", message: e.message, path: e.path });
    }
  }
  return errors;
}

/** LOW_CONTRAST for solid colour pairs on touched blocks that fail WCAG AA (§4.4: respect the contrast checks). */
export function contrastWarnings(
  doc: PageDoc,
  keys: Set<string>
): AgentWarning[] {
  const out: AgentWarning[] = [];
  for (const block of doc.blocks) {
    if (!keys.has(block._key)) {
      continue;
    }
    const def = getBlockDef(block._type);
    if (!def) {
      continue;
    }
    const merged = mergeStyle(def.defaultStyle, block.style);
    const onCard = (def.onCard?.length ?? 0) > 0;
    const check = (
      label: string,
      fg: Color | undefined,
      large: boolean,
      card: boolean
    ) => {
      const rating = rateContrast(fg, merged, large, card);
      if (rating.kind === "rated" && !rating.pass) {
        out.push({
          code: "LOW_CONTRAST",
          key: block._key,
          message: `${label} on the block background is ${rating.ratio.toFixed(2)}:1, below WCAG AA ${rating.threshold}:1`,
        });
      }
    };
    check("Text colour", merged.colors?.text, false, onCard);
    check("Heading colour", merged.colors?.heading, false, onCard);
    check("Accent colour", merged.colors?.accent, false, onCard);
    for (const [name, el] of Object.entries(merged.elements ?? {})) {
      check(
        `Element "${name}" colour`,
        el.color,
        isLargeSize(el.size?.desktop),
        def.onCard?.includes(name) ?? false
      );
    }
  }
  return out;
}

/**
 * Stages an SEO proposal on `base`: every variant (or the patch alone, without variants) must give
 * a valid page. `mediaExists` checks the share image is in the library.
 */
/**
 * A title template's text around `%s` (e.g. "%s | Example Site" → suffix " | Example Site").
 * The site wraps every non-exact SEO title in it (seo/build-head.ts `pageTitle`).
 */
function templateParts(template: string): { prefix: string; suffix: string } {
  const at = template.indexOf("%s");
  return at < 0
    ? { prefix: "", suffix: "" }
    : { prefix: template.slice(0, at), suffix: template.slice(at + 2) };
}

/** `title` without the template's prefix and suffix when it already carries them (case-insensitive). */
export function bareTitle(title: string, template: string): string {
  const { prefix, suffix } = templateParts(template);
  let out = title.trim();
  const p = prefix.trim();
  const sfx = suffix.trim();
  if (
    sfx &&
    out.length > sfx.length &&
    out.toLowerCase().endsWith(sfx.toLowerCase())
  ) {
    out = out.slice(0, -sfx.length).trim();
  }
  if (
    p &&
    out.length > p.length &&
    out.toLowerCase().startsWith(p.toLowerCase())
  ) {
    out = out.slice(p.length).trim();
  }
  return out || title;
}

/**
 * Not in the source: models tend to write the full `<title>` ("… | Site name"), which
 * the template then wraps again. Unless the proposal's title is exact (its own `titleExact`, else
 * the page's), titles lose a trailing (or leading) copy of the template text. `stripped` counts the
 * titles changed, for the tool result.
 */
export function withBareTitles(
  proposal: SeoProposal,
  template: string,
  pageTitleExact: boolean | undefined
): { proposal: SeoProposal; stripped: number } {
  if (proposal.seo.titleExact ?? pageTitleExact) {
    return { proposal, stripped: 0 };
  }
  let stripped = 0;
  const fix = (t: string) => {
    const bare = bareTitle(t, template);
    if (bare !== t) {
      stripped++;
    }
    return bare;
  };
  const seo =
    proposal.seo.title === undefined
      ? proposal.seo
      : { ...proposal.seo, title: fix(proposal.seo.title) };
  const variants = proposal.variants.map((v) => ({
    ...v,
    title: fix(v.title),
  }));
  return { proposal: { ...proposal, seo, variants }, stripped };
}

export function stageSeo(
  base: PageDoc,
  proposal: SeoProposal
): StageFail | { ok: true; doc: PageDoc } {
  const variants = proposal.variants.length ? proposal.variants : [undefined];
  let first: PageDoc | null = null;
  const errors: AgentToolError[] = [];
  variants.forEach((variant, i) => {
    const op = seoOpFor(proposal, variant);
    let doc: PageDoc;
    try {
      doc = applyOps(base, [op]).doc;
    } catch (err) {
      if (!(err instanceof OpError)) {
        throw err;
      }
      errors.push({ code: "INVALID_SEO", message: err.message });
      return;
    }
    for (const e of pageLimitErrors(doc, { seo: true })) {
      errors.push({
        code: "INVALID_SEO",
        message: e.message,
        path: variant ? `variants[${i}] → ${e.path}` : e.path,
      });
    }
    first ??= doc;
  });
  if (errors.length || !first) {
    return { ok: false, errors };
  }
  if (deepEqual(first, base) && proposal.variants.length === 0) {
    return fail("INVALID_SEO", "This proposal changes nothing");
  }
  return { ok: true, doc: first };
}

function fail(code: AgentErrorCode, message: string, path?: string): StageFail {
  return { ok: false, errors: [{ code, message, ...(path && { path }) }] };
}
