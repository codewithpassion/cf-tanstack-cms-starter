import { DEVICES, hiddenOn, mergeStyle } from "../style/vars";
import type { JsonLd, PageDoc, Visibility } from "../types";
import { parseBlock } from "../validate";

/**
 * JSON-LD contributed by the page's blocks, for the route's head(). Invalid blocks contribute
 * nothing, and neither do blocks hidden on every device, or whose `jsonLdElement` is (structured
 * data must match visible content).
 */
export function collectJsonLd(doc: PageDoc): JsonLd[] {
  const out: JsonLd[] = [];
  for (const raw of doc.blocks) {
    const { def, block, props } = parseBlock(raw);
    if (!(def?.jsonLd && block)) {
      continue;
    }
    const style = mergeStyle(def.defaultStyle, block.style);
    if (hiddenEverywhere(style.hide)) {
      continue;
    }
    if (
      def.jsonLdElement &&
      hiddenEverywhere(style.elements?.[def.jsonLdElement]?.hide)
    ) {
      continue;
    }
    const ld = def.jsonLd(props, { doc, block });
    if (ld) {
      out.push(...(Array.isArray(ld) ? ld : [ld]));
    }
  }
  return out;
}

const hiddenEverywhere = (hide: Visibility | undefined) =>
  hiddenOn(hide).length === DEVICES.length;
