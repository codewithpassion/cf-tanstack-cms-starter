import { computeStyleVars, mergeStyle } from "@repo/cms-core/style/vars";
import type { BlockStyle } from "@repo/cms-core/types";
import type { ReactNode } from "react";

import { BlockKeyContext, useEditMode } from "./edit-mode";
import { ElementStylesContext } from "./field";

type BlockWrapperProps = {
  type: string;
  blockKey: string;
  /** The block definition's default style. */
  defaultStyle?: BlockStyle;
  /** The document's (already validated) style overrides. */
  style?: BlockStyle;
  children: ReactNode;
};

/**
 * Owns the block's outer spacing, background, border and visibility (via style/cms.css).
 * The component inside owns its inner layout only.
 */
export function BlockWrapper({
  type,
  blockKey,
  defaultStyle,
  style,
  children,
}: BlockWrapperProps) {
  const { editing, selectedKey } = useEditMode();
  const merged = mergeStyle(defaultStyle, style);
  const { style: vars, attrs } = computeStyleVars(merged, undefined);
  const editAttrs = editing
    ? {
        "data-cms-block": type,
        "data-cms-key": blockKey,
        "data-cms-selected": selectedKey === blockKey ? "" : undefined,
      }
    : {};
  return (
    <section className="cms-block" style={vars} {...attrs} {...editAttrs}>
      <BlockKeyContext.Provider value={blockKey}>
        <ElementStylesContext.Provider value={merged.elements}>
          <div className="cms-inner">{children}</div>
        </ElementStylesContext.Provider>
      </BlockKeyContext.Provider>
    </section>
  );
}
