// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
import { applyOps, OpError } from "../ops/apply-ops";
import { deepEqual } from "../ops/json";
import type { Block, InsertAt, Op, PageDoc } from "../types";
import type { SeoProposal, SeoVariant } from "./types";

/**
 * Reviewing a staged changeset in the editor: ops are grouped per block, a
 * subset can be accepted, and blocks the user changed since the proposal are flagged. Pure and
 * registry-free, so the editor chunk can use it.
 */

/** "post" for `setPost`, "seo" for `setSeo`, else the block's key. */
export function groupOf(op: Op): string {
  switch (op.op) {
    case "insert":
      return op.block._key ?? "";
    case "setSeo":
      return "seo";
    case "setPost":
      return "post";
    default:
      return op.key;
  }
}

/** Group keys in the order they first appear. */
export function groupsOf(ops: readonly Op[]): string[] {
  return [...new Set(ops.map(groupOf))];
}

export type GroupConflict = { group: string; reason: "changed" | "deleted" };

/**
 * Groups whose target changed since the proposal was staged: the block differs from the one the
 * agent saw, or it was deleted. Inserted blocks never conflict.
 */
export function conflicts(
  base: PageDoc,
  current: PageDoc,
  ops: readonly Op[]
): GroupConflict[] {
  const inserted = new Set(
    ops.flatMap((op) =>
      op.op === "insert" && op.block._key ? [op.block._key] : []
    )
  );
  const out: GroupConflict[] = [];
  for (const group of groupsOf(ops)) {
    if (inserted.has(group)) {
      continue;
    }
    if (group === "post") {
      if (!deepEqual(base.post, current.post)) {
        out.push({ group, reason: "changed" });
      }
      continue;
    }
    if (group === "seo") {
      if (!deepEqual(base.seo, current.seo)) {
        out.push({ group, reason: "changed" });
      }
      continue;
    }
    const before = base.blocks.find((b) => b._key === group);
    const now = current.blocks.find((b) => b._key === group);
    if (!now) {
      out.push({ group, reason: "deleted" });
    } else if (!deepEqual(before, now)) {
      out.push({ group, reason: "changed" });
    }
  }
  return out;
}

/**
 * The ops of the accepted groups, made to apply to `current`: an insert or move anchored on a block
 * that isn't there (rejected, or deleted since) is re-anchored after the nearest earlier block of
 * the proposed page that is; ops on a deleted block are dropped (`skipped`).
 */
export function opsToApply(
  current: PageDoc,
  ops: readonly Op[],
  accepted: ReadonlySet<string>,
  proposed: PageDoc
): { ops: Op[]; skipped: string[] } {
  let doc = current;
  const out: Op[] = [];
  const skipped = new Set<string>();
  for (const raw of ops) {
    const group = groupOf(raw);
    if (!accepted.has(group)) {
      continue;
    }
    let op = raw;
    const has = (key: string) => doc.blocks.some((b) => b._key === key);
    if (op.op === "insert" || op.op === "move") {
      const at = op.op === "insert" ? op.at : op.to;
      const anchor = at.after ?? at.before;
      if (
        (anchor !== undefined && !has(anchor)) ||
        (at.index !== undefined && at.index > doc.blocks.length)
      ) {
        const key = op.op === "insert" ? op.block._key! : op.key;
        const fixed = anchorFor(key, proposed, doc);
        op = op.op === "insert" ? { ...op, at: fixed } : { ...op, to: fixed };
      }
    }
    if (
      (op.op === "update" ||
        op.op === "replace" ||
        op.op === "remove" ||
        op.op === "move") &&
      !has(op.key)
    ) {
      skipped.add(group);
      continue;
    }
    try {
      doc = applyOps(doc, [op]).doc;
      out.push(op);
    } catch (err) {
      if (!(err instanceof OpError)) {
        throw err;
      }
      skipped.add(group);
    }
  }
  return { ops: out, skipped: [...skipped] };
}

/** After the nearest block before `key` in `proposed` that exists in `doc`; the top when there is none. */
function anchorFor(key: string, proposed: PageDoc, doc: PageDoc): InsertAt {
  const idx = proposed.blocks.findIndex((b) => b._key === key);
  for (let i = idx - 1; i >= 0; i--) {
    const k = proposed.blocks[i]!._key;
    if (k !== key && doc.blocks.some((b) => b._key === k)) {
      return { after: k };
    }
  }
  return { index: 0 };
}

/** The page as it would be with every op of the changeset applied to `current` (what the ghost overlay shows). */
export function proposedDoc(
  current: PageDoc,
  ops: readonly Op[],
  groups?: ReadonlySet<string>
): PageDoc {
  const all = new Set(groups ?? groupsOf(ops));
  // Anchors are resolved against the agent's own result, staged on `current` op by op.
  let staged = current;
  try {
    staged = applyOps(current, [...ops]).doc;
  } catch {
    // Conflicts: fall back to the per-op path below.
  }
  return applyOps(current, opsToApply(current, ops, all, staged).ops).doc;
}

/** The `setSeo` op for an SEO proposal with the chosen title/description variant. */
export function seoOpFor(
  proposal: SeoProposal,
  variant: SeoVariant | undefined
): Op {
  const seo: Record<string, unknown> = { ...proposal.seo };
  if (variant) {
    seo.title = variant.title;
    seo.description = variant.description;
  }
  return { op: "setSeo", seo };
}

/** Blocks inserted by these ops, by key. */
export function insertedBlocks(ops: readonly Op[]): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const op of ops) {
    if (op.op === "insert" && op.block._key) {
      out.set(op.block._key, op.block as Block);
    }
  }
  return out;
}
