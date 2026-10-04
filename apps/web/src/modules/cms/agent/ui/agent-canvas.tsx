// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source UI; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
import { conflicts, groupsOf } from "@repo/cms-core/agent/changeset";
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { type BlockChange, diffDocs } from "@repo/cms-core/editor/diff";
import type { PageDoc } from "@repo/cms-core/types";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import { useCanvas } from "../../editor/canvas-frame";
import { useAgentState, useAgentView } from "./agent-view";

/**
 * The ghost overlay (docs/cms-plan.md §4.4): while a proposal is reviewed, the canvas shows the
 * page with its selected blocks applied, read-only. Inserted blocks are outlined green, changed
 * blocks blue (amber for style-only changes) with the changed fields named, blocks the user
 * edited since the proposal red. Lives inside the canvas iframe (`data-cms-ui`).
 */

const COLOR = {
  added: "#22c55e",
  changed: "#38bdf8",
  style: "#f59e0b",
  moved: "#a3a3a3",
  conflict: "#ef4444",
} as const;

type Mark = { key: string; color: string; label: string };

function marksFor(
  draft: PageDoc,
  proposed: PageDoc,
  base: PageDoc | null,
  ops: Parameters<typeof conflicts>[2]
): Mark[] {
  const diff = diffDocs(draft, proposed);
  const conflicted = new Set(
    base ? conflicts(base, draft, ops).map((c) => c.group) : []
  );
  return diff.blocks
    .filter(
      (b): b is Exclude<BlockChange, { status: "removed" }> =>
        b.status !== "removed"
    )
    .map((b) => {
      const name = getBlockDef(b.type)?.label ?? b.type;
      if (conflicted.has(b.key)) {
        return {
          key: b.key,
          color: COLOR.conflict,
          label: `${name}: you changed this block after the proposal`,
        };
      }
      if (b.status === "added") {
        return { key: b.key, color: COLOR.added, label: `New ${name}` };
      }
      if (b.status === "moved") {
        return { key: b.key, color: COLOR.moved, label: `${name} moved` };
      }
      const styleOnly = b.fields.every((f) => f.path.startsWith("style"));
      const fields = [
        ...new Set(
          b.fields.map((f) =>
            f.path.replace(/\[.*$/, "").replace(/^style\.([^.]+).*/, "style.$1")
          )
        ),
      ];
      return {
        key: b.key,
        color: styleOnly ? COLOR.style : COLOR.changed,
        label: `${name}: ${fields.slice(0, 4).join(", ")}${fields.length > 4 ? "…" : ""}`,
      };
    });
}

/** Inside the canvas: outlines and a label per proposed block. */
export function AgentCanvasMarks({
  draft,
  proposed,
}: {
  draft: PageDoc;
  proposed: PageDoc;
}) {
  const canvas = useCanvas();
  const state = useAgentState();
  const cs = state.changesets.find((c) => c.id === state.preview?.id);
  const base = useMemo(
    () => (cs?.baseDocJson ? (JSON.parse(cs.baseDocJson) as PageDoc) : null),
    [cs?.baseDocJson]
  );
  const marks = useMemo(
    () => (cs?.ops ? marksFor(draft, proposed, base, cs.ops) : []),
    [draft, proposed, base, cs?.ops]
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!canvas) {
      return;
    }
    const reflow = () => setTick((n) => n + 1);
    canvas.window.addEventListener("resize", reflow);
    const ro = new (
      canvas.window as unknown as typeof globalThis
    ).ResizeObserver(reflow);
    ro.observe(canvas.body);
    return () => {
      canvas.window.removeEventListener("resize", reflow);
      ro.disconnect();
    };
  }, [canvas]);
  useLayoutEffect(() => setTick((n) => n + 1), [proposed]);

  // Scroll the first proposed block into view when the review opens.
  const first = marks[0]?.key;
  useEffect(() => {
    if (!(canvas && first)) {
      return;
    }
    const el = canvas.document.querySelector(
      `[data-cms-key="${CSS.escape(first)}"]`
    );
    if (el) {
      canvas.window.scrollBy({
        top: el.getBoundingClientRect().top - 48,
        behavior: "smooth",
      });
    }
  }, [canvas, first]);

  if (!canvas) {
    return null;
  }
  const css = marks
    .map(
      (m) =>
        `[data-cms-key="${CSS.escape(m.key)}"] { outline: 3px solid ${m.color} !important; outline-offset: -3px; }`
    )
    .join("\n");
  const frameWidth =
    canvas.window.frameElement?.getBoundingClientRect().width ??
    canvas.window.innerWidth;
  const zoom = Math.min(
    2.5,
    Math.max(1, canvas.window.innerWidth / Math.max(1, frameWidth))
  );
  return (
    <div data-cms-ui="" data-testid="agent-marks">
      <style>{css}</style>
      {marks.map((m) => {
        const el = canvas.document.querySelector(
          `[data-cms-key="${CSS.escape(m.key)}"]`
        );
        if (!el) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        return (
          <div
            key={m.key}
            data-testid="agent-mark-label"
            style={{
              position: "absolute",
              top: rect.top + canvas.window.scrollY + 6,
              left: rect.left + 6,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              zIndex: 60,
              background: m.color,
              maxWidth: Math.max(160, rect.width / zoom - 24),
            }}
            className="pointer-events-none truncate rounded px-1.5 py-0.5 font-sans text-xs font-semibold text-black shadow"
          >
            Agent · {m.label}
          </div>
        );
      })}
    </div>
  );
}

/** Above the canvas while a proposal is reviewed. */
export function AgentReviewBar() {
  const view = useAgentView();
  const state = useAgentState();
  const cs = state.changesets.find((c) => c.id === state.preview?.id);
  if (!(cs?.ops && state.preview)) {
    return null;
  }
  const total = groupsOf(cs.ops).length;
  const selected = state.preview.groups.length;
  const busy = state.deciding === cs.id;
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm text-foreground"
      role="status"
      data-testid="agent-review-bar"
    >
      <span>
        Reviewing the agent's proposal: <strong>{cs.summary}</strong>.{" "}
        {selected} of {total} block{total === 1 ? "" : "s"} selected. Read-only
        until you decide.
      </span>
      <span className="flex items-center gap-3 text-xs text-muted-foreground">
        {(["added", "changed", "style", "conflict"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ outline: `2px solid ${COLOR[k]}` }}
            />
            {k === "style"
              ? "style only"
              : k === "conflict"
                ? "you changed it"
                : k}
          </span>
        ))}
      </span>
      <div className="ml-auto flex gap-2">
        <Button
          size="sm"
          onClick={() => void view.accept(cs.id)}
          disabled={busy || !selected}
          data-testid="agent-bar-accept"
        >
          Accept {selected === total ? "all" : `${selected}`}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void view.reject(cs.id)}
          disabled={busy}
          data-testid="agent-bar-reject"
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => view.closePreview()}
          data-testid="agent-bar-close"
        >
          Close
        </Button>
      </div>
    </div>
  );
}
