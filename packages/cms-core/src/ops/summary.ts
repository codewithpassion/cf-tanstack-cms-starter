import type { Block, PageDoc } from "../types";

import { deepEqual, isPlainObject, type PlainObject } from "./json";

/**
 * One-line, model-free change summary for revisions, diffed by `_key`:
 * "Edited Hero heading · mobile padding top 48→32 · added FAQ (4 items) · SEO title changed".
 */

export type LabelFor = (blockType: string) => string;

const MAX_PARTS = 6;
const DEVICES = new Set(["desktop", "tablet", "mobile"]);

export function summarizeChange(
  prev: PageDoc,
  next: PageDoc,
  labelFor: LabelFor
): string {
  const parts: string[] = [];
  const prevByKey = new Map(prev.blocks.map((b) => [b._key, b]));
  const nextKeys = new Set(next.blocks.map((b) => b._key));

  for (const block of next.blocks) {
    const old = prevByKey.get(block._key);
    const label = labelFor(block._type);
    if (!old) {
      parts.push(`added ${label}${itemCount(block)}`);
    } else if (old._type === block._type) {
      parts.push(...blockChanges(old, block, label));
    } else {
      parts.push(`replaced ${labelFor(old._type)} with ${label}`);
    }
  }
  for (const block of prev.blocks) {
    if (!nextKeys.has(block._key)) {
      parts.push(`removed ${labelFor(block._type)}`);
    }
  }
  const keptBefore = prev.blocks
    .map((b) => b._key)
    .filter((k) => nextKeys.has(k));
  const keptAfter = next.blocks
    .map((b) => b._key)
    .filter((k) => prevByKey.has(k));
  if (!deepEqual(keptBefore, keptAfter)) {
    parts.push("reordered blocks");
  }

  const seoKeys = changedKeys(prev.seo, next.seo);
  if (seoKeys.length) {
    parts.push(`SEO ${seoKeys.join(", ")} changed`);
  }
  if (!prev.post && next.post) {
    parts.push("added post details");
  } else if (prev.post && !next.post) {
    parts.push("removed post details");
  } else {
    const postKeys = changedKeys(prev.post, next.post);
    if (postKeys.length) {
      parts.push(`post ${postKeys.join(", ")} changed`);
    }
  }

  if (!parts.length) {
    return "No changes";
  }
  const shown = parts.slice(0, MAX_PARTS);
  if (parts.length > MAX_PARTS) {
    shown.push(`+${parts.length - MAX_PARTS} more`);
  }
  const text = shown.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function blockChanges(old: Block, block: Block, label: string): string[] {
  const out: string[] = [];
  const props = changedKeys(old.props, block.props);
  if (props.length) {
    out.push(`Edited ${label} ${props.join(", ")}`);
  }
  for (const change of styleChanges(old.style, block.style, [])) {
    out.push(out.length ? change : `${label} ${change}`);
  }
  if (!(out.length || deepEqual(old, block))) {
    out.push(`Edited ${label}`);
  }
  return out;
}

/** Leaf-level style diff, e.g. padding.mobile.top 48→32 becomes "mobile padding top 48→32". */
function styleChanges(a: unknown, b: unknown, path: string[]): string[] {
  if (deepEqual(a, b)) {
    return [];
  }
  if (isBranch(a) || isBranch(b)) {
    const ao = isBranch(a) ? a : {};
    const bo = isBranch(b) ? b : {};
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])];
    return keys.flatMap((k) => styleChanges(ao[k], bo[k], [...path, k]));
  }
  const device = path.find((p) => DEVICES.has(p));
  const name = [device, ...path.filter((p) => p !== device && p !== "elements")]
    .filter((p): p is string => Boolean(p))
    .map(words)
    .join(" ");
  const from = formatValue(a);
  const to = formatValue(b);
  if (b === undefined) {
    return [`${name} reset`];
  }
  if (a !== undefined && from !== undefined && to !== undefined) {
    return [`${name} ${from}→${to}`];
  }
  return [`${name} ${to ?? "changed"}`];
}

/** Colors ({token} / {hex}) are leaves; any other object is walked. */
function isBranch(v: unknown): v is PlainObject {
  return isPlainObject(v) && !("token" in v) && !("hex" in v);
}

function formatValue(v: unknown): string | undefined {
  if (
    typeof v === "number" ||
    typeof v === "string" ||
    typeof v === "boolean"
  ) {
    return String(v);
  }
  if (isPlainObject(v)) {
    if (typeof v.token === "string") {
      return v.token;
    }
    if (typeof v.hex === "string") {
      return v.hex;
    }
  }
}

function changedKeys(a: unknown, b: unknown): string[] {
  const ao = isPlainObject(a) ? a : {};
  const bo = isPlainObject(b) ? b : {};
  return [...new Set([...Object.keys(ao), ...Object.keys(bo)])]
    .filter((k) => !deepEqual(ao[k], bo[k]))
    .map(words);
}

function itemCount(block: Block): string {
  const list = isPlainObject(block.props) ? block.props.items : undefined;
  if (!Array.isArray(list)) {
    return "";
  }
  return ` (${list.length} ${list.length === 1 ? "item" : "items"})`;
}

/** camelCase → lower-case words: "focusKeyphrase" → "focus keyphrase". */
function words(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}
