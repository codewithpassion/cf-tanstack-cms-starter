// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source UI; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.

import { MAX_PLAN_ITEMS } from "@repo/cms-core/agent/plan";
import type { SeoGscOverview } from "@repo/cms-core/gsc/shape";
import {
  AGENT_UNFIXABLE_CHECKS,
  buildFixPrompt,
  FIX_PARAM,
  type FixTarget,
  stashFixPrompt,
} from "@repo/cms-core/seo/fix-prompt";
import type { SeoOverviewRow } from "@repo/cms-core/seo/overview-table";
import { Sparkles, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Button } from "#/components/ui/button";

/**
 * What's picked on /admin/seo for "Fix with agent", shared by the Pages and Opportunities views:
 * per CMS page, the check issues, its striking-distance queries and/or its not-indexed status. A
 * site-wide run holds at most `MAX_PLAN_ITEMS` pages, so a new page can't be added past that.
 */

type Picked = {
  issues: ReadonlySet<string>;
  striking: boolean;
  notIndexed: boolean;
};
export type FixSelection = ReadonlyMap<string, Picked>;

const EMPTY: Picked = { issues: new Set(), striking: false, notIndexed: false };
const isEmpty = (p: Picked) =>
  p.issues.size === 0 && !p.striking && !p.notIndexed;

/** The issues on a row the agent can work on. */
export const fixableIssues = (row: SeoOverviewRow) =>
  row.issues.filter((i) => !AGENT_UNFIXABLE_CHECKS.has(i.id));

/** The picked pages as prompt targets, in the order they were picked. */
export function selectionTargets(
  selection: FixSelection,
  rows: readonly SeoOverviewRow[],
  gsc: SeoGscOverview | null
): FixTarget[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const striking = new Map(
    (gsc?.striking ?? []).flatMap((p) =>
      p.pageId ? [[p.pageId, p.queries] as const] : []
    )
  );
  const notIndexed = new Map((gsc?.notIndexed ?? []).map((p) => [p.pageId, p]));
  return [...selection].flatMap(([pageId, picked]) => {
    const row = byId.get(pageId);
    const ni = notIndexed.get(pageId);
    if (!(row || ni)) {
      return [];
    }
    return [
      {
        pageId,
        path: row?.path ?? new URL(ni!.url).pathname,
        title: row?.pageTitle ?? ni!.title,
        issues: row ? row.issues.filter((i) => picked.issues.has(i.id)) : [],
        queries: picked.striking ? (striking.get(pageId) ?? []) : [],
        notIndexed:
          picked.notIndexed && ni ? { inspection: ni.inspection } : null,
      },
    ];
  });
}

type FixSelectionApi = {
  selection: FixSelection;
  /** Whether this page can't be added (the run is full). */
  full: (pageId: string) => boolean;
  update: (pageId: string, change: (p: Picked) => Picked) => void;
  clear: () => void;
};

const Ctx = createContext<FixSelectionApi | null>(null);

export function FixSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<FixSelection>(new Map());
  const update = useCallback(
    (pageId: string, change: (p: Picked) => Picked) => {
      setSelection((s) => {
        const next = new Map(s);
        const picked = change(s.get(pageId) ?? EMPTY);
        if (isEmpty(picked)) {
          next.delete(pageId);
        } else if (s.has(pageId) || s.size < MAX_PLAN_ITEMS) {
          next.set(pageId, picked);
        }
        return next;
      });
    },
    []
  );
  const api = useMemo<FixSelectionApi>(
    () => ({
      selection,
      full: (pageId) =>
        !selection.has(pageId) && selection.size >= MAX_PLAN_ITEMS,
      update,
      clear: () => setSelection(new Map()),
    }),
    [selection, update]
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useFixSelection(): FixSelectionApi {
  const api = useContext(Ctx);
  if (!api) {
    throw new Error("useFixSelection needs FixSelectionProvider");
  }
  return api;
}

const FULL_TITLE = `A run covers at most ${MAX_PLAN_ITEMS} pages`;

/** One check issue's checkbox. */
export function IssueCheckbox({
  pageId,
  issueId,
}: {
  pageId: string;
  issueId: string;
}) {
  const { selection, full, update } = useFixSelection();
  if (AGENT_UNFIXABLE_CHECKS.has(issueId)) {
    return (
      <span
        className="inline-block w-3.5"
        title="The agent can't change the URL or indexing settings"
      />
    );
  }
  const checked = selection.get(pageId)?.issues.has(issueId) ?? false;
  return (
    <input
      type="checkbox"
      className="mr-1.5 align-middle"
      checked={checked}
      disabled={!checked && full(pageId)}
      title={!checked && full(pageId) ? FULL_TITLE : "Send to the agent"}
      onChange={(e) =>
        update(pageId, (p) => {
          const issues = new Set(p.issues);
          if (e.target.checked) {
            issues.add(issueId);
          } else {
            issues.delete(issueId);
          }
          return { ...p, issues };
        })
      }
      aria-label="Send this issue to the agent"
      data-testid="seo-fix-issue"
    />
  );
}

/** A row's checkbox: all of its fixable issues at once. */
export function RowCheckbox({ row }: { row: SeoOverviewRow }) {
  const { selection, full, update } = useFixSelection();
  const ids = fixableIssues(row).map((i) => i.id);
  if (!ids.length) {
    return null;
  }
  const picked = selection.get(row.id)?.issues ?? EMPTY.issues;
  const all = ids.every((id) => picked.has(id));
  const some = !all && ids.some((id) => picked.has(id));
  return (
    <input
      type="checkbox"
      checked={all}
      ref={(el) => {
        if (el) {
          el.indeterminate = some;
        }
      }}
      disabled={!(all || some) && full(row.id)}
      title={
        !(all || some) && full(row.id)
          ? FULL_TITLE
          : "Send this page's issues to the agent"
      }
      onChange={(e) =>
        update(row.id, (p) => ({
          ...p,
          issues: new Set(e.target.checked ? ids : []),
        }))
      }
      aria-label={`Send ${row.path}'s issues to the agent`}
      data-testid="seo-fix-row"
    />
  );
}

/** Striking distance or not indexed, for one CMS page. */
export function OpportunityCheckbox({
  pageId,
  kind,
}: {
  pageId: string;
  kind: "striking" | "notIndexed";
}) {
  const { selection, full, update } = useFixSelection();
  const checked = selection.get(pageId)?.[kind] ?? false;
  return (
    <input
      type="checkbox"
      className="mr-2 align-middle"
      checked={checked}
      disabled={!checked && full(pageId)}
      title={!checked && full(pageId) ? FULL_TITLE : "Send to the agent"}
      onChange={(e) =>
        update(pageId, (p) => ({ ...p, [kind]: e.target.checked }))
      }
      aria-label="Send to the agent"
      data-testid={`seo-fix-${kind}`}
    />
  );
}

/**
 * The bar under the header: what's picked, and "Fix with agent", which opens the first page's
 * editor on a new site-wide conversation that starts with the findings (the agent plans; you
 * approve the plan; every change stays a draft for review).
 */
export function FixBar({
  rows,
  gsc,
}: {
  rows: readonly SeoOverviewRow[];
  gsc: SeoGscOverview | null;
}) {
  const { selection, clear } = useFixSelection();
  const [error, setError] = useState<string | null>(null);
  if (!selection.size) {
    return null;
  }
  const start = () => {
    const targets = selectionTargets(selection, rows, gsc);
    try {
      const key = stashFixPrompt(sessionStorage, buildFixPrompt(targets));
      window.location.assign(
        `/admin/editor/${encodeURIComponent(targets[0]!.pageId)}?agent=site&${FIX_PARAM}=${key}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div
      className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-3 rounded border border-primary/40 bg-card/95 px-4 py-2 text-sm backdrop-blur"
      data-testid="seo-fix-bar"
    >
      <span className="text-foreground">
        {selection.size} of at most {MAX_PLAN_ITEMS}{" "}
        {selection.size === 1 ? "page" : "pages"} picked
      </span>
      <span className="text-xs text-muted-foreground">
        The agent plans a site-wide run from these; you approve the plan, and
        every change stays a draft for review.
      </span>
      {!!error && <span className="text-destructive">{error}</span>}
      <div className="ml-auto flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={clear}
          data-testid="seo-fix-clear"
        >
          <X className="h-4 w-4" /> Clear
        </Button>
        <Button size="sm" onClick={start} data-testid="seo-fix-start">
          <Sparkles className="h-4 w-4" /> Fix with agent
        </Button>
      </div>
    </div>
  );
}
