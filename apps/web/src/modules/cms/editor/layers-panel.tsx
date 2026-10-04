// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  duplicate,
  moveBy,
  moveTo,
  remove,
} from "@repo/cms-core/editor/block-ops";
import { richTextToPlainText } from "@repo/cms-core/richtext/plain-text";
import type { RichTextDoc } from "@repo/cms-core/richtext/schema";
import type { Block } from "@repo/cms-core/types";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { getBlock } from "../blocks/registry";
import { useEditorState, useEditorStore } from "./use-editor-store";

/** The page outline: select, reorder (buttons or drag), duplicate, delete, add. Lives in the parent document. */
export function LayersPanel({
  onAdd,
  onNotice,
}: {
  onAdd: () => void;
  onNotice: (message: string) => void;
}) {
  const store = useEditorStore();
  const { doc, selectedKey } = useEditorState();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const run = (op: ReturnType<typeof moveBy>) => {
    if (!op) {
      return;
    }
    const res = store.apply([op]);
    if (!res.ok) {
      onNotice(res.errors[0]?.message ?? "That change couldn't be made");
    }
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }
    const to = doc.blocks.findIndex((b) => b._key === over.id);
    run(moveTo(doc, String(active.id), to));
  };

  return (
    <div className="flex h-full flex-col" data-testid="layers-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Layers
        </h2>
        <button
          type="button"
          onClick={onAdd}
          data-testid="add-block"
          className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-black hover:bg-accent/80"
        >
          <Plus className="h-3.5 w-3.5" /> Add block
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {doc.blocks.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">No blocks yet.</p>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={doc.blocks.map((b) => b._key)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-1">
              {doc.blocks.map((block, i) => (
                <LayerRow
                  key={block._key}
                  block={block}
                  index={i}
                  count={doc.blocks.length}
                  selected={block._key === selectedKey}
                  onSelect={() => store.select(block._key)}
                  onMove={(delta) => run(moveBy(doc, block._key, delta))}
                  onDuplicate={() => run(duplicate(doc, block._key))}
                  onDelete={() => run(remove(doc, block._key))}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

/** "Hero · Page heading": the type plus the block's first short text, so similar blocks are told apart. */
const isRichDoc = (v: unknown): v is RichTextDoc =>
  typeof v === "object" &&
  v !== null &&
  (v as { type?: unknown }).type === "doc";

export function blockSummary(block: Block): { label: string; detail: string } {
  const def = getBlock(block._type);
  const props = (block.props ?? {}) as Record<string, unknown>;
  // `headlineLead`, `name`, `brand`: the event hero, bio and top bar, which have no `heading`.
  const text = [
    "heading",
    "title",
    "headlineLead",
    "name",
    "brand",
    "caption",
    "alt",
  ]
    .map((k) => props[k])
    .find((v) => typeof v === "string" && v) as string | undefined;
  // The event footer has only rich text.
  const rich = isRichDoc(props.left) ? richTextToPlainText(props.left) : "";
  return { label: def?.label ?? block._type, detail: text ?? rich };
}

type LayerRowProps = {
  block: Block;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
};

function LayerRow({
  block,
  index,
  count,
  selected,
  onSelect,
  onMove,
  onDuplicate,
  onDelete,
}: LayerRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: block._key,
  });
  const def = getBlock(block._type);
  const Icon = def?.Icon;
  const { label, detail } = blockSummary(block);
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      data-testid="layer-row"
      data-key={block._key}
      className={`group flex items-center gap-1 rounded border px-1 py-1 text-sm ${
        selected
          ? "border-primary bg-accent/10"
          : "border-transparent hover:bg-muted"
      } ${isDragging ? "opacity-70 shadow-lg" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag ${label}`}
        className="cursor-grab touch-none p-0.5 text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        data-testid="layer-select"
      >
        {!!Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate">
          <span className="text-foreground">{label}</span>
          {!!detail && (
            <span className="text-muted-foreground"> · {detail}</span>
          )}
        </span>
      </button>
      <div
        className={`flex items-center ${selected ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
      >
        <RowButton
          label="Move up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton
          label="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton label="Duplicate" onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton label="Delete" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </RowButton>
      </div>
    </li>
  );
}

function RowButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}
