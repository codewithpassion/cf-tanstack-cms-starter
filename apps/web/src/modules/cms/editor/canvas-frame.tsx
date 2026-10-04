// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting it would make the port hard to diff against the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/noShadow: ported verbatim; the inner width/height are the observed size.

import type { Device } from "@repo/cms-core/types";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { mirrorStyles } from "./mirror-styles";

/**
 * Editor canvas: a same-origin about:blank iframe at the device width,
 * scaled to fit the available width and as tall as the panel it sits in (the frame's viewport
 * height is the panel height divided by the scale, never less than MIN_CANVAS_HEIGHT), with the
 * editor's React tree portalled into it. One React root, so state and
 * context flow straight from the editor into the page components. The iframe has its own viewport,
 * so Tailwind breakpoints and cms.css media queries follow the canvas width, not the browser's.
 *
 * The selected block's outline comes from `data-cms-selected`, which BlockWrapper renders from
 * `EditModeContext.selectedKey`.
 */

/** Same breakpoints as cms.css: desktop >= 1024, tablet 768-1023, mobile < 768. */
export function deviceForWidth(width: number): Device {
  return width >= 1024 ? "desktop" : width >= 768 ? "tablet" : "mobile";
}

/** Device presets: widths only. The canvas height follows the editor panel (see CanvasFrame). */
export const DEVICE_PRESETS: Record<Device, { width: number }> = {
  desktop: { width: 1440 },
  tablet: { width: 820 },
  mobile: { width: 390 },
};

/** The frame's viewport is never shorter than this (CSS px); a shorter panel scrolls instead. */
export const MIN_CANVAS_HEIGHT = 600;

export type CanvasSelection = { key: string; type: string };

export type EditorShortcut = "save" | "saveVersion" | "undo" | "redo";

/** Cmd/Ctrl+S, Cmd/Ctrl+Shift+S ("Save version…"), Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Cmd/Ctrl+Y. */
export function editorShortcut(e: KeyboardEvent): EditorShortcut | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) {
    return null;
  }
  const key = e.key.toLowerCase();
  if (key === "s") {
    return e.shiftKey ? "saveVersion" : "save";
  }
  if (key === "z") {
    return e.shiftKey ? "redo" : "undo";
  }
  if (key === "y" && !e.shiftKey) {
    return "redo";
  }
  return null;
}

type CanvasHandle = { document: Document; window: Window; body: HTMLElement };

const CanvasContext = createContext<CanvasHandle | null>(null);

/**
 * The canvas iframe's document, window and body. Null until the frame is ready (and briefly after
 * the frame is reset).
 *
 * Code rendered inside the canvas runs in the parent window's JavaScript realm, but its DOM lives
 * in the iframe. Blocks and anything they render must use this handle's `window` and `document`,
 * never the globals: `document.getElementById`, `window.matchMedia`, `innerWidth`, scroll
 * listeners and observers on the globals all see the editor page, not the canvas. Pass `body` as
 * the Radix `Portal container`.
 */
export function useCanvas(): CanvasHandle | null {
  return useContext(CanvasContext);
}

/** Styles the editor adds inside the frame, after the mirrored site styles. Never part of the published page. */
const EDITOR_CSS = `
html, body { margin: 0; }
/* No scrollbar gutter, so the viewport is exactly the preset width with classic scrollbars too. */
html { scrollbar-width: none; }
html::-webkit-scrollbar { display: none; }
[data-cms-key] { cursor: pointer; }
[data-cms-key]:hover { outline: 1px dashed rgb(59 130 246 / 0.6); outline-offset: -1px; }
[data-cms-key][data-cms-selected] { outline: 2px solid #3b82f6; outline-offset: -2px; }
/* Inline text editing (modules/cms/editor/canvas-tools.tsx). */
[data-cms-field][contenteditable] { cursor: text; }
[data-cms-field][contenteditable]:hover { outline: 1px dashed rgb(139 92 246 / 0.7); outline-offset: 2px; }
[data-cms-editing] { outline: 1px solid #8b5cf6 !important; outline-offset: 2px; }
`;

/** Controls that stay inert inside a block in edit mode, unless inside `[data-cms-interactive]`. */
const CONTROLS = "a, button, input, select, textarea, label, summary";

/** Clicks here belong to an open popover or dialog, or the editor's own UI in the frame; they never change the selection. */
const OVERLAYS =
  "[data-radix-popper-content-wrapper], [role=dialog], [data-cms-ui]";

type CanvasFrameProps = {
  width: number;
  onSelect?: (selection: CanvasSelection | null) => void;
  /**
   * Every keydown inside the frame. Parent-window listeners never see these, so the editor's
   * shortcut handler must be wired here as well as on its own window. Editor shortcuts
   * (see `editorShortcut`) arrive with the browser default already prevented.
   */
  onKeyDown?: (e: KeyboardEvent) => void;
  children: ReactNode;
};

export function CanvasFrame({
  width,
  onSelect,
  onKeyDown,
  children,
}: CanvasFrameProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frame, setFrame] = useState<
    (CanvasHandle & { root: HTMLElement }) | null
  >(null);
  /** Bumped to replace the iframe element after the frame navigated away from about:blank. */
  const [generation, setGeneration] = useState(0);
  /** Measured size of the container (the panel); null until measured, and the canvas stays hidden until then. */
  const [available, setAvailable] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const callbacks = useRef({ onSelect, onKeyDown });
  callbacks.current = { onSelect, onKeyDown };

  // Set up the frame document once it exists. The initial about:blank document may already be
  // "complete" when this runs (Chromium) or arrive with a later load event (other engines), so
  // handle both and re-initialise if the document is replaced. If the frame navigates anywhere
  // else (a link or script got through), tear down and replace the iframe element.
  // A layout effect, so on unmount the cleanup removes the pagehide listener before React
  // detaches the iframe (which fires pagehide).
  useLayoutEffect(() => {
    const iframe = iframeRef.current!;
    let current: Document | null = null;
    let teardown: (() => void) | undefined;
    let disposed = false;

    const reset = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      // Unmount the portal now, while the window is still this origin's: components keep the
      // frame window (Radix Presence calls its clearTimeout on unmount), and once a cross-origin
      // page (e.g. a CSP or X-Frame-Options error page) commits, touching it throws.
      flushSync(() => setFrame(null));
      teardown?.();
      iframe.removeEventListener("load", init);
      setGeneration((g) => g + 1);
    };

    function init() {
      if (disposed) {
        return;
      }
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!(doc && win) || doc.URL !== "about:blank") {
        return reset();
      }
      if (!doc.body || doc === current) {
        return;
      }
      teardown?.();
      current = doc;

      doc.documentElement.lang = document.documentElement.lang || "en";
      const editorStyle = doc.createElement("style");
      editorStyle.textContent = EDITOR_CSS;
      doc.head.appendChild(editorStyle);
      const unmirror = mirrorStyles(document, doc, editorStyle);

      const root = doc.createElement("div");
      root.id = "cms-canvas-root";
      doc.body.appendChild(root);

      // All listeners are capture phase on the frame document, so component handlers (Radix
      // stops propagation) can't swallow them, and stopPropagation here keeps the event from
      // React and every other handler.
      const onClick = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target?.closest) {
          return;
        }
        // Links never navigate: the frame would load a real page (and the reset below).
        if (target.closest("a[href]")) {
          e.preventDefault();
        }
        if (target.closest(OVERLAYS)) {
          return;
        }
        const block = target.closest("[data-cms-key]");
        callbacks.current.onSelect?.(
          block
            ? {
                key: block.getAttribute("data-cms-key")!,
                type: block.getAttribute("data-cms-block") ?? "",
              }
            : null
        );
        // Buttons, links and inputs inside a block are inert while editing; selection still works.
        if (
          block &&
          target.closest(CONTROLS) &&
          !target.closest("[data-cms-interactive]")
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      const onSubmit = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };
      // A file or link dropped on the frame would navigate it. Drop targets opt in.
      const onDrag = (e: DragEvent) => {
        if (!(e.target as Element | null)?.closest?.("[data-cms-dropzone]")) {
          e.preventDefault();
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (editorShortcut(e)) {
          e.preventDefault();
        }
        callbacks.current.onKeyDown?.(e);
      };
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("submit", onSubmit, true);
      doc.addEventListener("dragover", onDrag, true);
      doc.addEventListener("drop", onDrag, true);
      doc.addEventListener("keydown", onKey, true);
      // Fires as a navigation commits, while the old document is still active.
      win.addEventListener("pagehide", reset);

      teardown = () => {
        teardown = undefined;
        win.removeEventListener("pagehide", reset);
        doc.removeEventListener("click", onClick, true);
        doc.removeEventListener("submit", onSubmit, true);
        doc.removeEventListener("dragover", onDrag, true);
        doc.removeEventListener("drop", onDrag, true);
        doc.removeEventListener("keydown", onKey, true);
        unmirror();
        editorStyle.remove();
        root.remove();
        current = null;
        setFrame(null);
      };
      setFrame({ document: doc, window: win, body: doc.body, root });
    }

    if (iframe.contentDocument?.readyState === "complete") {
      init();
    }
    iframe.addEventListener("load", init);
    return () => {
      disposed = true;
      iframe.removeEventListener("load", init);
      teardown?.();
    };
  }, [generation]);

  // Scale to the available width; fill the available height. Measured before paint, then on every
  // resize of the container. The container is sized by the panel (h-full), never by the frame, so
  // the frame's height can't feed back into it.
  useLayoutEffect(() => {
    const outer = outerRef.current!;
    const rect = outer.getBoundingClientRect();
    let last = { width: rect.width, height: rect.height };
    setAvailable(last);
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width === last.width && height === last.height) {
        return;
      }
      last = { width, height };
      setAvailable(last);
    });
    ro.observe(outer);
    return () => ro.disconnect();
  }, []);

  const handle = useMemo(
    () =>
      frame
        ? { document: frame.document, window: frame.window, body: frame.body }
        : null,
    [frame]
  );
  const scale = Math.max(
    0.01,
    Math.min(1, (available?.width ?? width) / width)
  );
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    Math.floor((available?.height ?? 0) / scale)
  );

  return (
    <div ref={outerRef} className="h-full w-full" data-testid="canvas-outer">
      <div
        style={{
          width: width * scale,
          height: height * scale,
          margin: "0 auto",
          position: "relative",
          overflow: "hidden",
          visibility: available === null ? "hidden" : undefined,
        }}
      >
        <iframe
          key={generation}
          ref={iframeRef}
          title="Page canvas"
          data-testid="canvas-iframe"
          data-scale={scale.toFixed(4)}
          data-viewport-height={height}
          style={{
            width,
            height,
            border: 0,
            display: "block",
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        />
      </div>
      {!!frame &&
        createPortal(
          <CanvasContext.Provider value={handle}>
            {children}
          </CanvasContext.Provider>,
          frame.root
        )}
    </div>
  );
}
