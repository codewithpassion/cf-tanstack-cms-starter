// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDefaultSwitchClause: switches over closed unions; TypeScript checks exhaustiveness, as in the source.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
import type {
  List,
  ListItem,
  Paragraph,
  RichTextDoc,
  RichTextMark,
  RichTextNode,
  RichTextText,
} from "../richtext/schema";

/**
 * The restricted rich-text schema (richtext/schema.ts) ↔ Markdown, for the AI page agent:
 * `get_page` shows rich text as Markdown and the write tools accept it.
 *
 * Supported: paragraphs, `##`/`###` headings, `-` and `1.` lists (nested, ordered lists keep their
 * start number), `>` blockquotes holding paragraphs and lists, `**bold**`, `*italic*`, `` `code` ``
 * and `[links](href)`. An empty paragraph is written as `<p></p>`. Anything outside the schema
 * that a model may still write degrades instead of failing: `#` becomes an H2, `####` and deeper an
 * H3, a heading inside a list or quote a paragraph, a fenced code block code-marked paragraphs, a
 * rule nothing. `fromMarkdown(toMarkdown(doc))` deep-equals `doc` once marks are in canonical order
 * (`canonicalRichText`). Pure; no DOM.
 */

const MARK_ORDER: RichTextMark["type"][] = ["link", "bold", "italic", "code"];

// ---------------------------------------------------------------------------------------------
// JSON → Markdown

export function toMarkdown(doc: RichTextDoc): string {
  return blocksToMd(doc.content).join("\n\n");
}

/** Two lists of the same kind in a row would read back as one list: an empty comment keeps them apart. */
const LIST_BREAK = "<!-- -->";

function blocksToMd(
  nodes: readonly (RichTextNode | Paragraph | List)[]
): string[] {
  const out: string[] = [];
  nodes.forEach((node, i) => {
    const prev = nodes[i - 1];
    if (
      prev &&
      prev.type === node.type &&
      (node.type === "bulletList" || node.type === "orderedList")
    ) {
      out.push(LIST_BREAK);
    }
    out.push(blockToMd(node));
  });
  return out;
}

function blockToMd(node: RichTextNode): string {
  switch (node.type) {
    case "paragraph":
      return node.content?.length ? inlineToMd(node.content, true) : "<p></p>";
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${inlineToMd(node.content ?? [], false)}`.trimEnd();
    case "bulletList":
    case "orderedList":
      return listToMd(node);
    case "blockquote":
      return blocksToMd(node.content)
        .join("\n\n")
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
  }
}

function listToMd(list: List): string {
  const start = list.type === "orderedList" ? (list.attrs?.start ?? 1) : 1;
  return list.content
    .map((item, i) => {
      const marker = list.type === "orderedList" ? `${start + i}. ` : "- ";
      return itemToMd(item, marker);
    })
    .join("\n");
}

/** The first child sits on the marker line; the rest are indented to the content column. */
function itemToMd(item: ListItem, marker: string): string {
  const pad = " ".repeat(marker.length);
  const parts = item.content.map((child, i) => {
    const text = blockToMd(child);
    const prev = item.content[i - 1];
    // A paragraph after another child needs a blank line, or it would join the line above.
    const gap = i > 0 && child.type === "paragraph" && prev ? "\n" : "";
    return { text, gap };
  });
  const lines: string[] = [];
  parts.forEach(({ text, gap }, i) => {
    const childLines = text.split("\n");
    if (gap) {
      lines.push("");
    }
    childLines.forEach((line, j) => {
      if (i === 0 && j === 0) {
        lines.push(marker + line);
      } else {
        lines.push(line ? pad + line : "");
      }
    });
  });
  return lines.join("\n");
}

/** Marks opened and closed across text nodes (like prosemirror-markdown), so `**a *b***` round-trips. */
function inlineToMd(
  nodes: readonly RichTextText[],
  atBlockStart: boolean
): string {
  let out = "";
  let open: RichTextMark[] = [];
  nodes.forEach((node, index) => {
    const marks = sortMarks(node.marks ?? []);
    // Close every open mark from the first one that differs (innermost last).
    let keep = 0;
    while (
      keep < open.length &&
      keep < marks.length &&
      sameMark(open[keep]!, marks[keep]!)
    ) {
      keep++;
    }
    for (let i = open.length - 1; i >= keep; i--) {
      out += closeMark(open[i]!);
    }
    open = open.slice(0, keep);
    for (let i = keep; i < marks.length; i++) {
      if (marks[i]!.type === "code") {
        continue;
      }
      out += openMark(marks[i]!);
      open.push(marks[i]!);
    }
    const text = node.text.replace(/\n/g, " ");
    const code = marks.some((m) => m.type === "code");
    if (code) {
      out += codeSpan(text);
    } else {
      let escaped = escapeText(text, atBlockStart && index === 0 && out === "");
      // Spaces next to a delimiter, or at either end of the block, would be lost: write them as `\ `.
      const marked = marks.length > 0;
      if (marked || index === 0) {
        escaped = escaped.replace(/^ /, "\\ ");
      }
      if (marked || index === nodes.length - 1) {
        escaped = escaped.replace(/ $/, "\\ ");
      }
      out += escaped;
    }
  });
  for (let i = open.length - 1; i >= 0; i--) {
    out += closeMark(open[i]!);
  }
  return out;
}

function sameMark(a: RichTextMark, b: RichTextMark): boolean {
  return (
    a.type === b.type &&
    (a.type !== "link" || (b.type === "link" && a.attrs.href === b.attrs.href))
  );
}

function openMark(m: RichTextMark): string {
  return m.type === "link"
    ? "["
    : m.type === "bold"
      ? "**"
      : m.type === "italic"
        ? "*"
        : "";
}

function closeMark(m: RichTextMark): string {
  if (m.type === "link") {
    const href = m.attrs.href;
    return /[\s()<>]/.test(href)
      ? `](<${href.replace(/[<>]/g, encodeURIComponent)}>)`
      : `](${href})`;
  }
  return m.type === "bold" ? "**" : m.type === "italic" ? "*" : "";
}

function codeSpan(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length)
  );
  const fence = "`".repeat(longest + 1);
  const pad =
    text.startsWith("`") || text.endsWith("`") || /^ .* $/.test(text)
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Backslash-escapes Markdown syntax; at a block's start also what would open a heading, list or quote. */
function escapeText(text: string, lineStart: boolean): string {
  let out = text.replace(/[\\`*_[\]<]/g, (c) => `\\${c}`);
  if (lineStart) {
    out = out.replace(
      /^(#{1,6}(?=\s|$)|>|[-+](?=\s)|(\d+)([.)])(?=\s))/,
      (m, _all, digits, dot) => (digits ? `${digits}\\${dot}` : `\\${m}`)
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Markdown → JSON

export function fromMarkdown(markdown: string): RichTextDoc {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");
  return { type: "doc", content: parseBlocks(lines, "top") as RichTextNode[] };
}

type Ctx = "top" | "nested";

const LIST_RE = /^( {0,3})([-*+]|(\d{1,9})[.)])( +|$)(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function parseBlocks(
  lines: string[],
  ctx: Ctx
): (RichTextNode | Paragraph | List)[] {
  const out: (RichTextNode | Paragraph | List)[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === LIST_BREAK) {
      i++;
      continue;
    }
    if (trimmed === "<p></p>") {
      out.push({ type: "paragraph" });
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) {
        body.push(lines[i++] as string);
      }
      i++;
      for (const text of body) {
        if (text.trim()) {
          out.push({
            type: "paragraph",
            content: [{ type: "text", text, marks: [{ type: "code" }] }],
          });
        }
      }
      continue;
    }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line) && !LIST_RE.exec(line)?.[5]) {
      i++;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/.exec(line);
    if (heading) {
      const content = parseInline(heading[2] ?? "");
      if (ctx === "top") {
        out.push(
          withContent(
            {
              type: "heading",
              attrs: { level: heading[1]!.length >= 3 ? 3 : 2 },
            },
            content
          ) as RichTextNode
        );
      } else {
        out.push(withContent({ type: "paragraph" }, content) as Paragraph);
      }
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        inner.push(lines[i++]!.replace(/^ {0,3}> ?/, ""));
      }
      const children = parseBlocks(inner, "nested").flatMap((c) =>
        c.type === "blockquote" ? (c.content as (Paragraph | List)[]) : [c]
      );
      if (ctx === "top" && children.length) {
        out.push({
          type: "blockquote",
          content: children as (Paragraph | List)[],
        });
      } else {
        out.push(...children);
      }
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      const { list, next } = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    // Paragraph: up to a blank line or the start of another block.
    const para: string[] = [];
    // Trailing spaces are dropped unless escaped (`\ `, written for a space at the end of the block).
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      (para.length === 0 || !startsBlock(lines[i]!))
    ) {
      para.push(lines[i++]!.replace(/^\s+/, "").replace(/(?<!\\)\s+$/, ""));
    }
    const content = parseInline(para.join(" "));
    out.push(withContent({ type: "paragraph" }, content) as Paragraph);
  }
  return out;
}

function startsBlock(line: string): boolean {
  return (
    /^ {0,3}(#{1,6}( |$)|>)/.test(line) ||
    LIST_RE.test(line) ||
    FENCE_RE.test(line) ||
    line.trim() === "<p></p>"
  );
}

function parseList(
  lines: string[],
  start: number
): { list: List; next: number } {
  const first = LIST_RE.exec(lines[start]!)!;
  const ordered = first[3] !== undefined;
  const bulletChar = first[2];
  const items: ListItem[] = [];
  let i = start;
  let startNumber = ordered ? Number(first[3]) : 1;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]!);
    if (!m) {
      break;
    }
    const isOrdered = m[3] !== undefined;
    if (isOrdered !== ordered || (!ordered && m[2] !== bulletChar)) {
      break;
    }
    if (items.length === 0) {
      startNumber = ordered ? Number(m[3]) : 1;
    }
    const contentCol =
      m[1]!.length + m[2]!.length + Math.max(1, Math.min(m[4]!.length, 4));
    const body = [
      m[4]!.length > 4 ? " ".repeat(m[4]!.length - 1) + m[5]! : m[5]!,
    ];
    i++;
    // Continuation: indented lines, and blank lines followed by indented lines.
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        const nextLine = lines.slice(i + 1).find((x) => x.trim());
        if (nextLine !== undefined && indentOf(nextLine) >= contentCol) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) >= contentCol) {
        body.push(l.slice(contentCol));
        i++;
        continue;
      }
      // A lazy continuation line of the item's paragraph.
      if (
        !startsBlock(l) &&
        body.at(-1)?.trim() &&
        !LIST_RE.test(body.at(-1)!)
      ) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    const children = parseBlocks(body, "nested").flatMap((c) =>
      c.type === "blockquote" ? (c.content as (Paragraph | List)[]) : [c]
    ) as (Paragraph | List)[];
    items.push({
      type: "listItem",
      content: children.length ? children : [{ type: "paragraph" }],
    });
    // A blank line between items keeps the list going.
    while (i < lines.length && !lines[i]!.trim()) {
      const nextLine = lines.slice(i + 1).find((x) => x.trim());
      if (
        nextLine !== undefined &&
        LIST_RE.test(nextLine) &&
        indentOf(nextLine) === indentOf(lines[start]!)
      ) {
        i++;
      } else {
        break;
      }
    }
  }
  const list: List = ordered
    ? {
        type: "orderedList",
        ...(startNumber !== 1 && { attrs: { start: startNumber } }),
        content: items,
      }
    : { type: "bulletList", content: items };
  return { list, next: i };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function withContent<T extends { type: string }>(
  node: T,
  content: RichTextText[]
): T & { content?: RichTextText[] } {
  return content.length ? { ...node, content } : node;
}

// --- inline ----------------------------------------------------------------------------------

export function parseInline(text: string): RichTextText[] {
  const out: RichTextText[] = [];
  inline(text, [], out);
  return mergeTexts(out);
}

function push(out: RichTextText[], text: string, marks: RichTextMark[]) {
  if (!text) {
    return;
  }
  const sorted = sortMarks(marks);
  out.push(
    sorted.length
      ? { type: "text", text, marks: sorted }
      : { type: "text", text }
  );
}

/** Finds the closing delimiter `delim` from `from`, skipping escapes, code spans and longer runs of the same character. */
function findClose(s: string, from: number, delim: string): number {
  const ch = delim[0];
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(j))![0];
      const end = s.indexOf(run, j + run.length);
      if (end > 0) {
        j = end + run.length - 1;
      }
      continue;
    }
    if (c === ch) {
      const run = new RegExp(`^\\${ch}+`).exec(s.slice(j))![0];
      if (run.length === delim.length && j > from) {
        return j;
      }
      // A longer run (e.g. ** inside a *…* span) is skipped whole, unless it ends with our delimiter.
      if (
        run.length > delim.length &&
        j > from &&
        !/\w/.test(s[j + run.length] ?? "")
      ) {
        return j + run.length - delim.length;
      }
      j += run.length - 1;
    }
  }
  return -1;
}

function inline(s: string, marks: RichTextMark[], out: RichTextText[]) {
  let buf = "";
  const flush = () => {
    push(out, buf, marks);
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (
      c === "\\" &&
      i + 1 < s.length &&
      /[\\`*_[\]<>#+\-.!(){}|~ ]/.test(s[i + 1]!)
    ) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let code = s.slice(i + run.length, end);
        if (/^ .*[^ ].* $/.test(code) || /^ `|` $/.test(code)) {
          code = code.slice(1, -1);
        }
        push(out, code, [...marks, { type: "code" }]);
        i = end + run.length;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const run = new RegExp(`^\\${c}+`).exec(s.slice(i))![0];
      const leftOk = c === "*" || i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]!);
      let matched = false;
      // `***a*b**` is bold around italic: try the longest delimiter first, then shorter ones.
      for (let n = Math.min(run.length, 3); leftOk && n >= 1 && !matched; n--) {
        if (!s[i + n] || s[i + n] === " ") {
          continue;
        }
        const close = findClose(s, i + n, c.repeat(n));
        if (close <= i + n) {
          continue;
        }
        flush();
        const add: RichTextMark[] =
          n === 3
            ? [{ type: "bold" }, { type: "italic" }]
            : n === 2
              ? [{ type: "bold" }]
              : [{ type: "italic" }];
        inline(s.slice(i + n, close), [...marks, ...add], out);
        i = close + n;
        matched = true;
      }
      if (matched) {
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (c === "[") {
      const link = parseLink(s, i);
      if (link) {
        flush();
        inline(
          link.text,
          [
            ...marks.filter((m) => m.type !== "link"),
            { type: "link", attrs: { href: link.href } },
          ],
          out
        );
        i = link.end;
        continue;
      }
    }
    if (c === "<") {
      const auto = /^<((?:https?:\/\/|mailto:|tel:)[^\s<>]+)>/.exec(s.slice(i));
      if (auto) {
        flush();
        push(out, auto[1]!, [
          ...marks,
          { type: "link", attrs: { href: auto[1]! } },
        ]);
        i += auto[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
}

function parseLink(
  s: string,
  start: number
): { text: string; href: string; end: number } | null {
  let depth = 0;
  let j = start;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") {
      depth++;
    } else if (c === "]" && --depth === 0) {
      break;
    }
  }
  if (j >= s.length || s[j + 1] !== "(") {
    return null;
  }
  const text = s.slice(start + 1, j);
  let k = j + 2;
  let href: string;
  if (s[k] === "<") {
    const end = s.indexOf(">", k);
    if (end < 0 || s[end + 1] !== ")") {
      return null;
    }
    href = s
      .slice(k + 1, end)
      .replace(/%3C/gi, "<")
      .replace(/%3E/gi, ">");
    k = end + 2;
  } else {
    let paren = 0;
    let e = k;
    for (; e < s.length; e++) {
      if (s[e] === "(") {
        paren++;
      } else if (s[e] === ")") {
        if (paren === 0) {
          break;
        }
        paren--;
      } else if (s[e] === " ") {
        break;
      }
    }
    // An optional title ("...") is dropped.
    const close = s.indexOf(")", e);
    if (close < 0) {
      return null;
    }
    href = s.slice(k, e);
    k = close + 1;
  }
  if (!href) {
    return null;
  }
  return { text, href, end: k };
}

function sortMarks(marks: readonly RichTextMark[]): RichTextMark[] {
  const seen = new Set<string>();
  const unique: RichTextMark[] = [];
  // The innermost link wins when links nest.
  for (const m of [...marks].reverse()) {
    if (seen.has(m.type)) {
      continue;
    }
    seen.add(m.type);
    unique.push(
      m.type === "link"
        ? { type: "link", attrs: { href: m.attrs.href } }
        : { type: m.type }
    );
  }
  return unique.sort(
    (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type)
  );
}

function mergeTexts(nodes: RichTextText[]): RichTextText[] {
  const out: RichTextText[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (prev && sameMarks(prev.marks ?? [], n.marks ?? [])) {
      out[out.length - 1] = { ...prev, text: prev.text + n.text };
    } else {
      out.push(n);
    }
  }
  return out;
}

function sameMarks(
  a: readonly RichTextMark[],
  b: readonly RichTextMark[]
): boolean {
  return a.length === b.length && a.every((m, i) => sameMark(m, b[i]!));
}

/**
 * The document with marks in canonical order, adjacent same-mark text merged and link attrs reduced
 * to `href`: what `fromMarkdown(toMarkdown(doc))` returns.
 */
export function canonicalRichText(doc: RichTextDoc): RichTextDoc {
  const walk = (node: RichTextNode | Paragraph | List | ListItem): unknown => {
    if (node.type === "paragraph" || node.type === "heading") {
      const content = mergeTexts(
        (node.content ?? [])
          .map((t) => ({ ...t, marks: sortMarks(t.marks ?? []) }))
          .map((t) =>
            t.marks?.length ? t : { type: "text" as const, text: t.text }
          )
      );
      const { content: _drop, ...rest } = node;
      return content.length ? { ...rest, content } : rest;
    }
    return {
      ...node,
      content: (node.content as (Paragraph | List | ListItem)[]).map(walk),
    };
  };
  return {
    type: "doc",
    content: doc.content.map((n) => walk(n) as RichTextNode),
  };
}
