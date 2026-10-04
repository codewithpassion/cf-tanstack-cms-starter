// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters kept as in the source.
import type { DocDiff } from "./diff";

/**
 * The publish dialog's one-line summary of a draft-vs-live diff (diff.ts), e.g.
 * "2 blocks changed, 1 added, 1 removed · 3 SEO fields". Pure, for tests.
 */

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export type PublishCounts = {
  added: number;
  removed: number;
  changed: number;
  moved: number;
  seo: number;
  post: number;
};

export function publishCounts(diff: DocDiff): PublishCounts {
  const counts: PublishCounts = {
    added: 0,
    removed: 0,
    changed: 0,
    moved: 0,
    seo: diff.seo.length,
    post: diff.post.length,
  };
  for (const change of diff.blocks) {
    counts[change.status]++;
  }
  return counts;
}

/** `live` null: the page has never been live (or was taken down), so everything is new. */
export function publishSummary(
  diff: DocDiff | null,
  blockCount: number
): string {
  if (!diff) {
    return `First publish: ${plural(blockCount, "block goes", "blocks go")} live.`;
  }
  if (!diff.changed) {
    return "No changes from the live page.";
  }
  const c = publishCounts(diff);
  const blockParts = [
    c.changed && `${c.changed} changed`,
    c.added && `${c.added} added`,
    c.removed && `${c.removed} removed`,
    c.moved && `${c.moved} moved`,
  ].filter((p): p is string => typeof p === "string");
  const totalBlocks = c.changed + c.added + c.removed + c.moved;
  const parts: string[] = [];
  if (blockParts.length) {
    parts.push(
      `${totalBlocks === 1 ? "1 block" : `${totalBlocks} blocks`}: ${blockParts.join(", ")}`
    );
  }
  if (c.seo) {
    parts.push(plural(c.seo, "SEO field", "SEO fields"));
  }
  if (c.post) {
    parts.push(plural(c.post, "post field", "post fields"));
  }
  return parts.join(" · ");
}
