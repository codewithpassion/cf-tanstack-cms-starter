// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.

import type { BlockCategory } from "@repo/cms-core/blocks/define";
import type { BlockType } from "@repo/cms-core/blocks/registry";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";

import { listBlocks } from "../blocks/registry";

const CATEGORY_LABELS: Record<BlockCategory, string> = {
  layout: "Layout",
  content: "Content",
  media: "Media",
  conversion: "Conversion",
};

/** "+ Add block": every registered block type (or only `types`, for posts), grouped by category. */
export function BlockPalette({
  open,
  onOpenChange,
  onPick,
  types,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: BlockType) => void;
  types?: readonly BlockType[];
}) {
  const groups = new Map<BlockCategory, ReturnType<typeof listBlocks>>();
  for (const def of listBlocks()) {
    if (types && !types.includes(def.type as BlockType)) {
      continue;
    }
    groups.set(def.category, [...(groups.get(def.category) ?? []), def]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl border-neutral-700 sm:max-w-xl bg-neutral-900 text-neutral-100"
        data-testid="block-palette"
      >
        <DialogHeader>
          <DialogTitle>Add a block</DialogTitle>
          <DialogDescription>
            It goes in where you clicked, or after the selected block.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {[...groups].map(([category, defs]) => (
            <section key={category}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {CATEGORY_LABELS[category]}
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {defs.map((def) => (
                  <button
                    key={def.type}
                    type="button"
                    data-testid={`palette-${def.type}`}
                    onClick={() => onPick(def.type as BlockType)}
                    className="flex items-center gap-2 rounded border border-neutral-700 px-3 py-3 text-left text-sm hover:border-accent hover:bg-accent/10"
                  >
                    <def.Icon className="h-5 w-5 shrink-0 text-accent" />
                    {def.label}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
