// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noMultiAssign: ported verbatim; kept as in the source.
import { deepEqual, isPlainObject } from "../ops/json";
import type { Block, PageDoc } from "../types";

/**
 * Document diff for the history panel: blocks matched by `_key`
 * (added / removed / changed / moved), field-level changes inside each block, SEO and post
 * fields, and a word-level diff for text (plain strings and rich text). Pure; no registry.
 *
 * Direction is always `base → target`: "added" is in target only, "removed" in base only.
 */

export type WordPart = { type: "same" | "add" | "del"; text: string };

export type FieldChange = {
  /** e.g. `heading`, `items[a].title`, `style.padding.mobile.top`, `seo.title`. List items are addressed by `_key`. */
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
  /** Word diff when both sides are text (strings or rich text). */
  words?: WordPart[];
  /** Both sides are rich text with the same text: only marks, links or structure changed. */
  formatting?: true;
};

export type BlockChange =
  | { status: "added"; key: string; type: string; block: Block }
  | { status: "removed"; key: string; type: string; block: Block }
  | {
      status: "changed";
      key: string;
      type: string;
      before: Block;
      after: Block;
      fields: FieldChange[];
      moved: boolean;
    }
  | { status: "moved"; key: string; type: string; block: Block };

export type DocDiff = {
  /** Target order, with removed blocks slotted in where they were in base. Unchanged blocks are left out. */
  blocks: BlockChange[];
  seo: FieldChange[];
  post: FieldChange[];
  /** Anything differs at all. */
  changed: boolean;
};

export function diffDocs(base: PageDoc, target: PageDoc): DocDiff {
  const baseByKey = new Map(base.blocks.map((b) => [b._key, b]));
  const targetKeys = new Set(target.blocks.map((b) => b._key));
  const moved = movedKeys(
    base.blocks.map((b) => b._key).filter((k) => targetKeys.has(k)),
    target.blocks.map((b) => b._key).filter((k) => baseByKey.has(k))
  );

  const blocks: BlockChange[] = [];
  let nextBase = 0;
  const removedAt = (i: number) => {
    // Removed blocks that sat before base index i (and after the previous kept one).
    for (; nextBase < base.blocks.length && nextBase <= i; nextBase++) {
      const b = base.blocks[nextBase]!;
      if (!targetKeys.has(b._key)) {
        blocks.push({
          status: "removed",
          key: b._key,
          type: b._type,
          block: b,
        });
      }
    }
  };
  for (const block of target.blocks) {
    const old = baseByKey.get(block._key);
    if (!old) {
      blocks.push({
        status: "added",
        key: block._key,
        type: block._type,
        block,
      });
      continue;
    }
    if (!moved.has(block._key)) {
      removedAt(base.blocks.indexOf(old));
    }
    const isMoved = moved.has(block._key);
    if (!deepEqual(old, block)) {
      blocks.push({
        status: "changed",
        key: block._key,
        type: block._type,
        before: old,
        after: block,
        fields: blockFields(old, block),
        moved: isMoved,
      });
    } else if (isMoved) {
      blocks.push({
        status: "moved",
        key: block._key,
        type: block._type,
        block,
      });
    }
  }
  removedAt(base.blocks.length);

  const seo = diffFields(base.seo, target.seo, "seo");
  const post = diffFields(base.post, target.post, "post");
  return {
    blocks,
    seo,
    post,
    changed: blocks.length > 0 || seo.length > 0 || post.length > 0,
  };
}

/** Field changes inside one block: props (paths without a prefix), `_type`/`_v`, then `style.*`. */
export function blockFields(before: Block, after: Block): FieldChange[] {
  const out: FieldChange[] = [];
  if (before._type !== after._type) {
    out.push({
      path: "_type",
      kind: "changed",
      before: before._type,
      after: after._type,
    });
  }
  out.push(...diffFields(before.props, after.props, ""));
  out.push(...diffFields(before.style, after.style, "style"));
  return out;
}

/**
 * Leaf-level differences between two JSON values. Objects are walked; arrays of `_key`ed items
 * are matched by key (an added or removed item is one change); other arrays, colours and rich
 * text are leaves.
 */
export function diffFields(
  a: unknown,
  b: unknown,
  path: string
): FieldChange[] {
  if (deepEqual(a, b)) {
    return [];
  }
  if (a === undefined) {
    return [leaf(path, "added", a, b)];
  }
  if (b === undefined) {
    return [leaf(path, "removed", a, b)];
  }
  if (isBranch(a) && isBranch(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffFields(a[k], b[k], join(path, k)));
  }
  if (isKeyedList(a) && isKeyedList(b)) {
    // (An empty list counts as keyed: deepEqual above already ruled out both being empty.)
    const bKeys = new Set(b.map((item) => item._key));
    const aByKey = new Map(a.map((item) => [item._key, item]));
    const out: FieldChange[] = [];
    for (const item of b) {
      const at = `${path}[${item._key}]`;
      const old = aByKey.get(item._key);
      if (old) {
        out.push(...diffFields(withoutKey(old), withoutKey(item), at));
      } else {
        out.push(leaf(at, "added", undefined, item));
      }
    }
    for (const item of a) {
      if (!bKeys.has(item._key)) {
        out.push(leaf(`${path}[${item._key}]`, "removed", item, undefined));
      }
    }
    const order = (list: { _key: string }[], keep: Set<string>) =>
      list.map((i) => i._key).filter((k) => keep.has(k));
    if (!deepEqual(order(a, bKeys), order(b, new Set(aByKey.keys())))) {
      out.push({ path, kind: "changed", before: "order", after: "order" });
    }
    return out;
  }
  return [leaf(path, "changed", a, b)];
}

function leaf(
  path: string,
  kind: FieldChange["kind"],
  before: unknown,
  after: unknown
): FieldChange {
  const change: FieldChange = { path, kind };
  if (before !== undefined) {
    change.before = before;
  }
  if (after !== undefined) {
    change.after = after;
  }
  const from = textOf(before);
  const to = textOf(after);
  if ((from !== null || to !== null) && (from ?? "") !== (to ?? "")) {
    change.words = wordDiff(from ?? "", to ?? "");
  } else if (isRichText(before) && isRichText(after)) {
    change.formatting = true;
  }
  return change;
}

/** Plain text of a string or rich-text document; null for anything else. */
export function textOf(v: unknown): string | null {
  if (typeof v === "string") {
    return v;
  }
  if (isRichText(v)) {
    return richTextToPlain(v);
  }
  return null;
}

export function isRichText(
  v: unknown
): v is { type: "doc"; content: unknown[] } {
  return isPlainObject(v) && v.type === "doc" && Array.isArray(v.content);
}

const INLINE_PARENTS = new Set(["paragraph", "heading"]);

/** Text of a rich-text document: text nodes joined, one line per paragraph, heading or list item. */
export function richTextToPlain(node: unknown): string {
  if (!isPlainObject(node)) {
    return "";
  }
  if (node.type === "text") {
    return typeof node.text === "string" ? node.text : "";
  }
  const children = Array.isArray(node.content)
    ? node.content.map(richTextToPlain)
    : [];
  return children.join(INLINE_PARENTS.has(String(node.type)) ? "" : "\n");
}

/** Above this many token pairs the LCS is skipped and the whole text shows as replaced. */
const MAX_LCS_CELLS = 250_000;

/** Word-level diff (words and the whitespace between them are tokens), merged into runs. */
export function wordDiff(a: string, b: string): WordPart[] {
  const x = tokens(a);
  const y = tokens(b);
  if (x.length * y.length > MAX_LCS_CELLS) {
    return merge([
      ...(a ? [{ type: "del" as const, text: a }] : []),
      ...(b ? [{ type: "add" as const, text: b }] : []),
    ]);
  }
  // lcs[i][j]: LCS length of x[i:] and y[j:].
  const lcs = Array.from(
    { length: x.length + 1 },
    () => new Uint32Array(y.length + 1)
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        x[i] === y[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const parts: WordPart[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      parts.push({ type: "same", text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      parts.push({ type: "del", text: x[i++]! });
    } else {
      parts.push({ type: "add", text: y[j++]! });
    }
  }
  while (i < x.length) {
    parts.push({ type: "del", text: x[i++]! });
  }
  while (j < y.length) {
    parts.push({ type: "add", text: y[j++]! });
  }
  return merge(groupChanges(parts));
}

/**
 * Readability: whitespace kept between two changes joins the change, and each run of changes
 * becomes one deletion then one insertion ("The [lead was rewritten for][original lead from]
 * version", not word-by-word interleaving).
 */
function groupChanges(parts: WordPart[]): WordPart[] {
  const out: WordPart[] = [];
  let del = "";
  let add = "";
  const flush = () => {
    if (del) {
      out.push({ type: "del", text: del });
    }
    if (add) {
      out.push({ type: "add", text: add });
    }
    del = add = "";
  };
  parts.forEach((p, k) => {
    const inChange = del !== "" || add !== "";
    const nextIsChange =
      parts[k + 1] !== undefined && parts[k + 1]!.type !== "same";
    if (p.type === "same" && inChange && nextIsChange && /^\s+$/.test(p.text)) {
      del += p.text;
      add += p.text;
    } else if (p.type === "del") {
      del += p.text;
    } else if (p.type === "add") {
      add += p.text;
    } else {
      flush();
      out.push(p);
    }
  });
  flush();
  return out;
}

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

function merge(parts: WordPart[]): WordPart[] {
  const out: WordPart[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last?.type === p.type) {
      last.text += p.text;
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/**
 * Keys (in both lists, same members) that are out of place: everything outside one longest common
 * subsequence of the two orders, so a single drag reports just the dragged block.
 */
function movedKeys(before: string[], after: string[]): Set<string> {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const stay = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      stay.add(before[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return new Set(after.filter((k) => !stay.has(k)));
}

/** A style colour: exactly `{token}` or `{hex}`. */
export function isColor(v: unknown): v is { token: string } | { hex: string } {
  if (!isPlainObject(v)) {
    return false;
  }
  const keys = Object.keys(v);
  return (
    keys.length === 1 &&
    (keys[0] === "token" || keys[0] === "hex") &&
    typeof v[keys[0]] === "string"
  );
}

/** Colours and rich text are leaves; any other object is walked. */
function isBranch(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && !isColor(v) && !isRichText(v);
}

function isKeyedList(
  v: unknown
): v is ({ _key: string } & Record<string, unknown>)[] {
  return (
    Array.isArray(v) &&
    v.every((i) => isPlainObject(i) && typeof i._key === "string")
  );
}

function withoutKey({ _key: _, ...rest }: Record<string, unknown>) {
  return rest;
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** The Post tab's names for post metadata (post-panel.tsx), for diff lists. */
const POST_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  excerpt: "Excerpt",
  author: "Author",
  publishedAt: "Published",
  publishedAtAuto: "Published (auto)",
  modifiedAt: "Updated",
  category: "Category",
  tags: "Tags",
  featuredImage: "Featured image",
  "featuredImage.mediaId": "Featured image",
  "featuredImage.alt": "Featured image alt text",
  readingTime: "Reading time",
  readingTimeOverride: "Reading time shown",
};

/** A diff path as shown to the editor: post fields get the Post tab's names; other paths stay as they are. */
export function fieldLabel(path: string): string {
  if (!path.startsWith("post.")) {
    return path;
  }
  const key = path.slice("post.".length);
  return `Post · ${POST_FIELD_LABELS[key] ?? key}`;
}
