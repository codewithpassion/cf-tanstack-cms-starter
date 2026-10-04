// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting it would make the port hard to diff against the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.

import {
  DEVICE_LABEL,
  dragValue,
  keyStepValue,
  paddingDragOp,
  SPACING_RANGE,
} from "@repo/cms-core/editor/style-model";
import type { Device } from "@repo/cms-core/types";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { getBlock } from "../blocks/registry";
import { useEditMode } from "../render/edit-mode";
import { useCanvas } from "./canvas-frame";
import { useEditorState, useEditorStore } from "./use-editor-store";

/**
 * Style tools inside the canvas frame: hidden blocks shown faded and
 * labelled for the device they're hidden on, and drag handles for the selected block's top and
 * bottom padding. Rendered by CanvasTools; everything carries `data-cms-ui`.
 */

// --- "Show hidden blocks" (toggled from the Style panel, read here) --------------------------------

let showHidden = true;
const showHiddenListeners = new Set<() => void>();

export function setShowHiddenBlocks(value: boolean) {
  showHidden = value;
  for (const l of showHiddenListeners) {
    l();
  }
}

export function useShowHiddenBlocks(): boolean {
  return useSyncExternalStore(
    (l) => {
      showHiddenListeners.add(l);
      return () => showHiddenListeners.delete(l);
    },
    () => showHidden,
    () => showHidden
  );
}

/**
 * cms.css hides `[data-cms-hide-<d>]` with `display: none` (one attribute). In the editor a block
 * (`[data-cms-key]`, two attributes, so this wins) stays on the canvas, faded, with a label.
 */
const MEDIA: Record<Device, string> = {
  desktop: "(width >= 1024px)",
  tablet: "(768px <= width < 1024px)",
  mobile: "(width < 768px)",
};
const SUFFIX: Record<Device, string> = {
  desktop: "d",
  tablet: "t",
  mobile: "m",
};

const HIDDEN_CSS = (Object.keys(MEDIA) as Device[])
  .map(
    (d) => `@media ${MEDIA[d]} {
[data-cms-key][data-cms-hide-${SUFFIX[d]}] { display: block; }
[data-cms-key][data-cms-hide-${SUFFIX[d]}] > .cms-inner { opacity: 0.35; }
[data-cms-key][data-cms-hide-${SUFFIX[d]}]::after { content: "Hidden on ${d}"; }
[data-cms-field][data-cms-hide-${SUFFIX[d]}] { display: revert-layer; opacity: 0.35; outline: 1px dashed rgb(255 255 255 / 0.5); outline-offset: 2px; }
[data-cms-collapses][data-cms-hide-${SUFFIX[d]}] { display: revert-layer; }
}`
  )
  .join("\n")
  .concat(`
[data-cms-key][data-cms-hide-d]::after, [data-cms-key][data-cms-hide-t]::after, [data-cms-key][data-cms-hide-m]::after {
	position: absolute; top: 8px; left: 8px; z-index: 55; pointer-events: none;
	padding: 2px 8px; border-radius: 4px; background: #404040; color: #fff;
	font: 600 12px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: normal; text-transform: none;
}`);

export function StyleCanvasTools({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const show = useShowHiddenBlocks();
  const { pageStatus } = useEditorState();
  return (
    <>
      {show && (
        <style data-cms-ui="" data-testid="hidden-blocks-css">
          {HIDDEN_CSS}
        </style>
      )}
      {pageStatus !== "archived" && <PaddingHandles onNotice={onNotice} />}
    </>
  );
}

// --- Padding drag handles ------------------------------------------------------------------------

type Edge = "top" | "bottom";

/**
 * Top and bottom padding handles on the selected block. While dragging, only the block's inline
 * `--cms-p{t,b}-<device>` variable changes (live preview, no ops); on release that's restored and
 * one `update` op is applied, so a drag is one undo step and one queued op. Escape cancels, from
 * the canvas or the editor around it. Focused, a handle takes the arrow keys (±4px, Shift ±16px),
 * one op per key.
 */
function PaddingHandles({ onNotice }: { onNotice: (message: string) => void }) {
  const canvas = useCanvas();
  const { device = "desktop" } = useEditMode();
  const { doc, selectedKey } = useEditorState();
  const store = useEditorStore();
  const [drag, setDrag] = useState<{ edge: Edge; value: number } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!canvas) {
      return;
    }
    const reflow = () => setTick((n) => n + 1);
    canvas.window.addEventListener("scroll", reflow, { passive: true });
    canvas.window.addEventListener("resize", reflow);
    const ro = new (
      canvas.window as unknown as typeof globalThis
    ).ResizeObserver(reflow);
    ro.observe(canvas.body);
    return () => {
      canvas.window.removeEventListener("scroll", reflow);
      canvas.window.removeEventListener("resize", reflow);
      ro.disconnect();
    };
  }, [canvas]);

  // Re-measure after the page renders (an edit may move the block).
  useLayoutEffect(() => {
    setTick((n) => n + 1);
  }, [doc, device]);

  const block = selectedKey
    ? doc.blocks.find((b) => b._key === selectedKey)
    : undefined;
  if (!(canvas && block)) {
    return null;
  }
  const el = canvas.document.querySelector<HTMLElement>(
    `[data-cms-key="${CSS.escape(block._key)}"]`
  );
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.height === 0) {
    return null;
  }
  const computed = canvas.window.getComputedStyle(el);
  const padding = {
    top: Number.parseFloat(computed.paddingTop) || 0,
    bottom: Number.parseFloat(computed.paddingBottom) || 0,
  };
  const scrollY = canvas.window.scrollY;
  const top = rect.top + scrollY;
  const bottom = rect.bottom + scrollY;
  const frameWidth =
    canvas.window.frameElement?.getBoundingClientRect().width ??
    canvas.window.innerWidth;
  const zoom = Math.min(
    2.5,
    Math.max(1, canvas.window.innerWidth / Math.max(1, frameWidth))
  );
  const x = rect.left + rect.width * 0.25;

  const start = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    // Keyboard focus follows the drag, so Escape reaches the canvas even if focus was in the editor.
    handle.focus({ preventScroll: true });
    const name = `--cms-${edge === "top" ? "pt" : "pb"}-${SUFFIX[device]}`;
    const prior = el.style.getPropertyValue(name);
    const from = padding[edge];
    const startY = e.clientY;
    let value = from;
    setDrag({ edge, value });

    const move = (ev: PointerEvent) => {
      value = dragValue(from, ev.clientY - startY);
      el.style.setProperty(name, `${value}px`);
      setDrag({ edge, value });
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      canvas.document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keydown", onKey, true);
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
      }
      // Hand the variable back to React before the op re-renders the block.
      if (prior) {
        el.style.setProperty(name, prior);
      } else {
        el.style.removeProperty(name);
      }
      setDrag(null);
      if (!commit || value === from) {
        return;
      }
      const current = store
        .getSnapshot()
        .doc.blocks.find((b) => b._key === block._key);
      if (!current) {
        return;
      }
      const op = paddingDragOp(
        current,
        getBlock(current._type)?.defaultStyle,
        device,
        edge,
        value
      );
      if (!op) {
        return;
      }
      const res = store.apply([op]);
      if (!res.ok) {
        onNotice(res.errors[0]?.message ?? "That padding can't be applied");
      }
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    // Both documents: focus may sit in the editor around the canvas.
    canvas.document.addEventListener("keydown", onKey, true);
    document.addEventListener("keydown", onKey, true);
  };

  const onKeyDown =
    (edge: Edge) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next = keyStepValue(Math.round(padding[edge]), e.key, e.shiftKey);
      if (next === null) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const current = store
        .getSnapshot()
        .doc.blocks.find((b) => b._key === block._key);
      if (!current || next === Math.round(padding[edge])) {
        return;
      }
      const op = paddingDragOp(
        current,
        getBlock(current._type)?.defaultStyle,
        device,
        edge,
        next
      );
      if (!op) {
        return;
      }
      const res = store.apply([op]);
      if (!res.ok) {
        onNotice(res.errors[0]?.message ?? "That padding can't be applied");
      }
    };

  const handles: { edge: Edge; y: number; area: [number, number] }[] = [
    { edge: "top", y: top + padding.top, area: [top, top + padding.top] },
    { edge: "bottom", y: bottom, area: [bottom - padding.bottom, bottom] },
  ];

  return (
    <div data-cms-ui="" data-testid="padding-handles">
      {handles.map(({ edge, y, area }) => {
        const active = drag?.edge === edge;
        const value = active ? drag.value : Math.round(padding[edge]);
        return (
          <div key={edge}>
            {/* The padding area, tinted while dragging. */}
            <div
              style={{
                position: "absolute",
                top: area[0],
                height: Math.max(0, area[1] - area[0]),
                left: rect.left,
                width: rect.width,
                zIndex: 54,
                pointerEvents: "none",
                background: active ? "rgb(59 130 246 / 0.12)" : "transparent",
              }}
            />
            <div
              role="slider"
              aria-label={`Padding ${edge} (${DEVICE_LABEL[device]})`}
              aria-valuenow={value}
              aria-valuemin={SPACING_RANGE[`padding.${edge}`][0]}
              aria-valuemax={SPACING_RANGE[`padding.${edge}`][1]}
              aria-orientation="vertical"
              tabIndex={0}
              title={`Drag, or use the arrow keys, to change padding ${edge} on ${DEVICE_LABEL[device]} (4px steps, Shift for 16)`}
              data-testid={`padding-handle-${edge}`}
              onPointerDown={start(edge)}
              onKeyDown={onKeyDown(edge)}
              style={{
                position: "absolute",
                top: y,
                left: x,
                transform: `translate(-50%, -50%) scale(${zoom})`,
                zIndex: 61,
                cursor: "ns-resize",
                touchAction: "none",
              }}
              className="group flex items-center gap-1 font-sans rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span className="block h-2 w-10 rounded-full border border-white bg-accent shadow" />
              <span
                className={`whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[11px] text-accent ${
                  active
                    ? ""
                    : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                }`}
                data-testid={`padding-handle-${edge}-value`}
              >
                {edge === "top" ? "Top" : "Bottom"} {value}px ·{" "}
                {DEVICE_LABEL[device]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
