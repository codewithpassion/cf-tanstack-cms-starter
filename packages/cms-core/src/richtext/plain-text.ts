// biome-ignore-all lint/suspicious/noUnnecessaryConditions: the walker also gets unvalidated documents, whose nodes may be null or malformed.
import type { RichTextDoc } from "./schema";

type AnyNode = { type?: string; text?: string; content?: AnyNode[] };

function plain(node: AnyNode): string {
  if (node?.type === "text") {
    return node.text ?? "";
  }
  const parts = (node?.content ?? []).map(plain);
  return parts.join(
    node?.type === "paragraph" || node?.type === "heading" ? "" : "\n"
  );
}

/** Plain text for SEO checks, JSON-LD and word counts. Blocks are separated by blank lines. */
export function richTextToPlainText(doc: RichTextDoc): string {
  return ((doc?.content ?? []) as AnyNode[]).map(plain).join("\n\n").trim();
}
