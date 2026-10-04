// biome-ignore-all lint/complexity/noForEach: ported verbatim; NodeList/Set iteration as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.
// biome-ignore-all lint/suspicious/useIterableCallbackReturn: forEach callbacks written as `cond && fn()` expressions, as in the source.

import { duplicate, moveBy, remove } from "@repo/cms-core/editor/block-ops";
import type { InsertAt } from "@repo/cms-core/types";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { getBlock } from "../blocks/registry";
import { useCanvas } from "./canvas-frame";
import { StyleCanvasTools } from "./style-canvas";
import { useEditorState, useEditorStore } from "./use-editor-store";

/**
 * Editing UI that lives INSIDE the canvas iframe, positioned in the frame's own coordinates (no
 * mapping through the canvas scale): the hover toolbar, "+" inserters between blocks, inline
 * plain-text editing, and the Style tools (style-canvas.tsx). Everything here carries
 * `data-cms-ui`, so the frame's click handler leaves the selection alone.
 */
export function CanvasTools(props: {
  onInsert: (at: InsertAt) => void;
  onNotice: (message: string) => void;
}) {
  return (
    <>
      <BlockTools {...props} />
      <StyleCanvasTools onNotice={props.onNotice} />
    </>
  );
}

function BlockTools({
  onInsert,
  onNotice,
}: {
  onInsert: (at: InsertAt) => void;
  onNotice: (message: string) => void;
}) {
  const canvas = useCanvas();
  const { doc, selectedKey, pageStatus } = useEditorState();
  const readOnly = pageStatus === "archived";
  const store = useEditorStore();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // Track the hovered block; hovering the toolbar itself keeps it.
  useEffect(() => {
    if (!canvas) {
      return;
    }
    const onOver = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest || target.closest("[data-cms-ui]")) {
        return;
      }
      setHoverKey(
        target.closest("[data-cms-key]")?.getAttribute("data-cms-key") ?? null
      );
    };
    const onLeave = () => setHoverKey(null);
    const reflow = () => setTick((n) => n + 1);
    canvas.document.addEventListener("mouseover", onOver);
    canvas.document.documentElement.addEventListener("mouseleave", onLeave);
    canvas.window.addEventListener("scroll", reflow, { passive: true });
    canvas.window.addEventListener("resize", reflow);
    const ro = new (
      canvas.window as unknown as typeof globalThis
    ).ResizeObserver(reflow);
    ro.observe(canvas.body);
    return () => {
      canvas.document.removeEventListener("mouseover", onOver);
      canvas.document.documentElement.removeEventListener(
        "mouseleave",
        onLeave
      );
      canvas.window.removeEventListener("scroll", reflow);
      canvas.window.removeEventListener("resize", reflow);
      ro.disconnect();
    };
  }, [canvas]);

  useInlineText(readOnly ? null : selectedKey, onNotice);

  // A block selected elsewhere (Layers, the palette) scrolls into view; one clicked on the canvas already is.
  useEffect(() => {
    if (!(canvas && selectedKey)) {
      return;
    }
    const el = canvas.document.querySelector(
      `[data-cms-key="${CSS.escape(selectedKey)}"]`
    );
    if (!el) {
      return;
    }
    // Scroll the frame only (scrollIntoView would also scroll the editor around it).
    const { top, bottom } = el.getBoundingClientRect();
    const view = canvas.window.innerHeight;
    if (top >= 0 && top < view - 40) {
      return;
    }
    if (bottom > 0 && top < 0 && bottom > view / 2) {
      return;
    }
    canvas.window.scrollBy({ top: top - 16 });
  }, [canvas, selectedKey]);

  // Re-measure after every render of the page (layout may have moved).
  useLayoutEffect(() => {
    setTick((n) => n + 1);
  }, [doc]);

  if (!canvas || readOnly) {
    return null;
  }
  const key =
    hoverKey && doc.blocks.some((b) => b._key === hoverKey)
      ? hoverKey
      : selectedKey;
  if (!key) {
    return doc.blocks.length ? null : (
      <EmptyCanvas onInsert={() => onInsert({})} />
    );
  }
  const el = canvas.document.querySelector(
    `[data-cms-key="${CSS.escape(key)}"]`
  );
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  const top = rect.top + canvas.window.scrollY;
  const bottom = rect.bottom + canvas.window.scrollY;
  // The frame is CSS-scaled to fit; counter-scale the tools so they stay a usable size.
  const frameWidth =
    canvas.window.frameElement?.getBoundingClientRect().width ??
    canvas.window.innerWidth;
  const zoom = Math.min(
    2.5,
    Math.max(1, canvas.window.innerWidth / Math.max(1, frameWidth))
  );
  const index = doc.blocks.findIndex((b) => b._key === key);
  const block = doc.blocks[index];
  const label = getBlock(block?._type ?? "")?.label ?? block?._type;
  const run = (op: ReturnType<typeof moveBy>) => {
    if (!op) {
      return;
    }
    const res = store.apply([op]);
    if (!res.ok) {
      onNotice(res.errors[0]?.message ?? "That change couldn't be made");
    }
  };

  return (
    <div data-cms-ui="" data-testid="canvas-tools">
      <div
        data-testid="block-toolbar"
        style={{
          position: "absolute",
          top: Math.max(0, top) + 4,
          left: rect.right - 4,
          transform: `translateX(-100%) scale(${zoom})`,
          transformOrigin: "top right",
          zIndex: 60,
        }}
        className="flex items-center gap-0.5 rounded bg-accent p-0.5 font-sans text-xs text-black shadow-lg"
      >
        <span className="whitespace-nowrap px-1.5 font-semibold">{label}</span>
        <ToolbarButton
          label="Move up"
          disabled={index <= 0}
          onClick={() => run(moveBy(doc, key, -1))}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Move down"
          disabled={index >= doc.blocks.length - 1}
          onClick={() => run(moveBy(doc, key, 1))}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Duplicate"
          onClick={() => run(duplicate(doc, key))}
        >
          <Copy className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Delete" onClick={() => run(remove(doc, key))}>
          <Trash2 className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
      <Inserter
        top={top}
        left={(rect.left + rect.right) / 2}
        zoom={zoom}
        label="Add block above"
        onClick={() => onInsert({ before: key })}
      />
      <Inserter
        top={bottom}
        left={(rect.left + rect.right) / 2}
        zoom={zoom}
        label="Add block below"
        onClick={() => onInsert({ after: key })}
      />
    </div>
  );
}

function ToolbarButton({
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
      className="rounded p-1 hover:bg-black/15 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Inserter({
  top,
  left,
  zoom,
  label,
  onClick,
}: {
  top: number;
  left: number;
  zoom: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid="canvas-insert"
      onClick={onClick}
      style={{
        position: "absolute",
        top,
        left,
        transform: `translate(-50%, -50%) scale(${zoom})`,
        zIndex: 60,
      }}
      className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-accent text-black shadow-lg hover:scale-110"
    >
      <Plus className="h-4 w-4" />
    </button>
  );
}

function EmptyCanvas({ onInsert }: { onInsert: () => void }) {
  return (
    <div
      data-cms-ui=""
      className="flex min-h-[50vh] items-center justify-center"
    >
      <button
        type="button"
        onClick={onInsert}
        className="flex items-center gap-2 border border-dashed border-white/40 px-6 py-4 font-sans text-white/70 hover:border-accent hover:text-accent"
      >
        <Plus className="h-5 w-5" /> Add the first block
      </button>
    </div>
  );
}

/**
 * Inline editing of the selected block's plain-text fields: an element marked with `field(name)`
 * whose text is exactly `props[name]` (a string) becomes `contentEditable="plaintext-only"`.
 * Elements that decorate their text (the eyebrow's "> " prefix) don't qualify and stay
 * inspector-only. Typing changes only the DOM; blur or Enter commits one `update` op (one undo
 * step), Escape restores the text. Either way the element gets back the text nodes React rendered
 * (with their text) before the op re-renders it, so React stays in control of the element.
 *
 * The binding is keyed on the block's primitive props (the plain-text fields, and flags that may
 * change which elements render), not on the whole props object: a rich-text save in the same block
 * must not unbind a heading the user is typing in. If the binding is torn down anyway while a field
 * is being edited, the typed text is committed first.
 */
function useInlineText(
  selectedKey: string | null,
  onNotice: (message: string) => void
) {
  const canvas = useCanvas();
  const store = useEditorStore();
  const { doc } = useEditorState();
  const block = selectedKey
    ? doc.blocks.find((b) => b._key === selectedKey)
    : undefined;
  const fieldsKey = block ? primitivePropsKey(block.props) : null;

  useEffect(() => {
    if (!(canvas && selectedKey) || fieldsKey === null) {
      return;
    }
    const blockEl = canvas.document.querySelector(
      `[data-cms-key="${CSS.escape(selectedKey)}"]`
    );
    if (!blockEl) {
      return;
    }
    const current = () =>
      store.getSnapshot().doc.blocks.find((b) => b._key === selectedKey);
    const values = (current()?.props ?? {}) as Record<string, unknown>;
    const cleanups: (() => void)[] = [];

    for (const el of blockEl.querySelectorAll<HTMLElement>(
      "[data-cms-field]"
    )) {
      if (el.closest("[data-cms-key]") !== blockEl) {
        continue;
      }
      const name = el.getAttribute("data-cms-field")!;
      const value = values[name];
      if (typeof value !== "string" || el.textContent !== value) {
        continue;
      }

      let original = value;
      let cancelled = false;
      // The text nodes React rendered, and their text, as of focus. Typing may edit, split or
      // remove them. React keeps references to the text nodes of a child component's text
      // (e.g. `Accented`), so the DOM is handed back with those very nodes: writing
      // `textContent` would swap in new nodes, and React's later update would land on the
      // detached ones (the canvas showing the old text, and the field no longer editable).
      let rendered: { nodes: ChildNode[]; text: (string | null)[] } | null =
        null;
      const restoreRendered = () => {
        if (!rendered) {
          el.textContent = original;
          return;
        }
        const { nodes, text } = rendered;
        nodes.forEach((n, i) => {
          if (n.nodeValue !== text[i]) {
            n.nodeValue = text[i]!;
          }
        });
        el.replaceChildren(...nodes);
        rendered = null;
      };
      const commit = () => {
        el.removeAttribute("data-cms-editing");
        const text = (el.textContent ?? "").replace(/\s*\n\s*/g, " ");
        // Hand the DOM back to React as it rendered it; the op's re-render writes the new text.
        // (Otherwise an undo in the same tick, as from the flusher, would leave the typed text
        // on screen: React sees the prop unchanged and never touches the element.)
        restoreRendered();
        if (cancelled) {
          cancelled = false;
          return;
        }
        if (text === original) {
          return;
        }
        const res = store.apply([
          { op: "update", key: selectedKey, props: { [name]: text } },
        ]);
        if (!res.ok) {
          onNotice(res.errors[0]?.message ?? "That text can't be saved");
        }
      };
      const onFocus = () => {
        original = (current()?.props as Record<string, unknown> | undefined)?.[
          name
        ] as string;
        const nodes = [...el.childNodes];
        rendered = { nodes, text: nodes.map((n) => n.nodeValue) };
        el.setAttribute("data-cms-editing", "");
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          el.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled = true;
          el.blur();
        }
      };
      // Commit before undo/redo/save so typing lands as its own step.
      const unregister = store.registerFlusher(() => {
        if (canvas.document.activeElement === el) {
          el.blur();
        }
      });
      el.setAttribute("contenteditable", "plaintext-only");
      el.setAttribute("spellcheck", "true");
      el.addEventListener("focus", onFocus);
      el.addEventListener("blur", commit);
      el.addEventListener("keydown", onKeyDown);
      cleanups.push(() => {
        unregister();
        el.removeEventListener("focus", onFocus);
        el.removeEventListener("blur", commit);
        el.removeEventListener("keydown", onKeyDown);
        // Mid-edit (focused): keep the typing. Not if the block is gone (nothing to update).
        if (el.hasAttribute("data-cms-editing") && current()) {
          commit();
        }
        el.removeAttribute("contenteditable");
        el.removeAttribute("spellcheck");
        el.removeAttribute("data-cms-editing");
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, [canvas, selectedKey, fieldsKey, store, onNotice]);
}

/** The block's top-level strings, numbers and booleans: what can change an inline field or whether it renders. */
function primitivePropsKey(props: unknown): string | null {
  if (!props || typeof props !== "object") {
    return null;
  }
  const entries = Object.entries(props as Record<string, unknown>).filter(
    ([, v]) => v === null || typeof v !== "object"
  );
  return JSON.stringify(entries);
}
