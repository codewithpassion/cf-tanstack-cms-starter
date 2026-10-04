// biome-ignore-all lint/suspicious/noUnnecessaryConditions: blocks come from unvalidated documents and may be null or malformed.
import type { Block, PageDoc } from "@repo/cms-core/types";
import { parseBlock } from "@repo/cms-core/validate";
import { useMemo } from "react";

import { getBlock } from "../blocks/registry";
import { BlockWrapper } from "./block-wrapper";
import { useEditMode } from "./edit-mode";
import { useCmsRender } from "./render-context";

/**
 * Renders a page document's blocks. Each block is validated at render time (cms-core
 * `parseBlock`): an unknown, retired or invalid block renders nothing on the public site and a
 * visible placeholder in the editor; an invalid style is dropped (its values would land in inline
 * CSS). The Component comes from the web registry. Page chrome (nav, footer) and JSON-LD belong to
 * the route.
 */
export function PageRenderer({ doc }: { doc: PageDoc }) {
  return (
    <>
      {doc.blocks.map((block, i) => (
        <BlockRenderer
          key={typeof block?._key === "string" ? block._key : i}
          block={block}
        />
      ))}
    </>
  );
}

function BlockRenderer({ block }: { block: Block }) {
  const { editing, selectedKey } = useEditMode();
  const render = useCmsRender();
  const parsed = useMemo(() => parseBlock(block), [block]);
  const web = parsed.block ? getBlock(parsed.block._type) : undefined;

  if (!(parsed.def && parsed.block && web)) {
    if (!editing) {
      return null;
    }
    const [first] = parsed.errors;
    return (
      <section
        data-cms-block={String(block?._type)}
        data-cms-key={String(block?._key)}
        data-cms-selected={
          typeof selectedKey === "string" && selectedKey === block?._key
            ? ""
            : undefined
        }
        className="py-8 px-4"
      >
        <div className="max-w-4xl mx-auto border border-dashed border-danger p-6 font-sans text-sm text-danger">
          Can't render block "{String(block?._type)}"
          {first ? `: ${first.path || "block"}: ${first.message}` : ""}
        </div>
      </section>
    );
  }

  const { Component, defaultStyle, hiddenWhen } = web;
  if (!editing && hiddenWhen?.(parsed.props, render)) {
    return null;
  }
  return (
    <BlockWrapper
      type={parsed.block._type}
      blockKey={parsed.block._key}
      defaultStyle={defaultStyle}
      style={parsed.style}
    >
      <Component props={parsed.props} />
    </BlockWrapper>
  );
}
