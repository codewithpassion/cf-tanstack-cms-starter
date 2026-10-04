// biome-ignore-all lint/a11y/noLabelWithoutControl: the label wraps a shadcn Switch (a button with role="switch"), which biome does not recognise as a control.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source; an admin-only table, not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: the sort button only renders for columns with a key.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: loader results are unions the effect narrows at runtime, as in the source.
import type { AdminResult } from "@repo/cms-core/admin-result";
import { fmtInt, fmtPosition } from "@repo/cms-core/gsc/format";
import {
  GSC_CONNECT_HINT,
  type SeoGscOverview,
} from "@repo/cms-core/gsc/shape";
import {
  rowsWithIssues,
  type SeoOverviewRow,
  type SeoSortKey,
  type SortDir,
  sortSeoRows,
  withGscMetrics,
} from "@repo/cms-core/seo/overview-table";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, CircleX, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Switch } from "#/components/ui/switch";
import {
  goToLogin,
  isUnauthorized,
  redirectOnUnauthorized,
} from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import { Opportunities } from "#/modules/cms/gsc/opportunities";
import {
  FixBar,
  FixSelectionProvider,
  IssueCheckbox,
  RowCheckbox,
} from "#/modules/cms/seo/fix-selection";

type GscOverviewResult = AdminResult<{
  gsc: SeoGscOverview;
  connected: boolean;
}>;

const getSeoGscOverview = (input: {
  minImpressions?: number;
}): Promise<GscOverviewResult> =>
  getTrpc().cms.gsc.getSeoGscOverview.query(input);

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * /admin/seo (docs/cms-plan.md §3.9): every page's SEO fields, check score and duplicates, from
 * the drafts. Rows are built on the server (seo/overview.ts), so this chunk carries no checks.
 * A row opens the editor on its SEO tab. Search Console (§3.10) adds 28-day clicks, impressions
 * and position per page and the Opportunities view (`#opportunities`); it loads separately, so the
 * table still shows when that data can't be read, and says how to connect when it isn't set up.
 * Issues, striking-distance pages and not-indexed pages can be picked and sent to the agent as one
 * site-wide run ("Fix with agent", src/modules/cms/seo/fix-selection.tsx).
 */
export const Route = createFileRoute("/admin/_shell/seo")({
  head: () => ({ meta: [{ title: "SEO | Admin" }] }),
  // Always fresh: titles change in the editor.
  gcTime: 0,
  loader: async ({ location }) => {
    const [overview, gsc] = await Promise.all([
      redirectOnUnauthorized(
        getTrpc().cms.seo.listSeoOverview.query(),
        location.href
      ),
      // Its own failure (e.g. Search Console not set up) must not hide the table.
      getSeoGscOverview({}).catch(
        (err: unknown): GscResult => ({ ok: false, message: errorText(err) })
      ),
    ]);
    return { overview, gsc };
  },
  component: SeoOverviewPage,
});

type View = "pages" | "opportunities";

function SeoOverviewPage() {
  const { overview, gsc: loaded } = Route.useLoaderData();
  const [view, setView] = useState<View>("pages");
  // After mount, so server and client render the same first view.
  useEffect(() => {
    if (window.location.hash === "#opportunities") {
      setView("opportunities");
    }
  }, []);
  const {
    gsc,
    connected,
    error: gscError,
    minImpressions,
    setMinImpressions,
  } = useGscOverview(loaded);
  const rows = useMemo(() => {
    if (!overview.ok) {
      return [];
    }
    return gsc ? withGscMetrics(overview.rows, gsc.byPageId) : overview.rows;
  }, [overview, gsc]);

  const pick = (v: View) => {
    setView(v);
    history.replaceState(
      history.state,
      "",
      v === "opportunities"
        ? "#opportunities"
        : location.pathname + location.search
    );
  };
  return (
    <FixSelectionProvider>
      <div className="p-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-bold font-heading text-2xl">SEO</h1>
            <p className="mt-1 text-muted-foreground text-sm">
              Every page's search and share settings and checks, from the
              current drafts.
            </p>
          </div>
          <div
            className="flex shrink-0 rounded border border-border text-sm"
            role="tablist"
          >
            {(["pages", "opportunities"] as const).map((v) => (
              <button
                aria-selected={view === v}
                className={`whitespace-nowrap px-4 py-1.5 ${view === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`seo-view-${v}`}
                key={v}
                onClick={() => pick(v)}
                role="tab"
                type="button"
              >
                {v === "pages" ? "Pages" : "Opportunities"}
              </button>
            ))}
          </div>
        </div>
        <FixBar gsc={gsc} rows={rows} />
        {!!gscError && (
          <p className="mb-4 text-amber-700 dark:text-amber-300 text-sm">
            Search Console data couldn't be loaded: {gscError}
          </p>
        )}
        {view === "opportunities" ? (
          gsc ? (
            <Opportunities
              connected={connected}
              gsc={gsc}
              minImpressions={minImpressions}
              onMinImpressions={setMinImpressions}
            />
          ) : null
        ) : overview.ok ? (
          <SeoTable
            connected={connected}
            gscRange={gsc?.range ?? null}
            rows={rows}
          />
        ) : (
          <p className="text-destructive">{overview.message}</p>
        )}
      </div>
    </FixSelectionProvider>
  );
}

type GscResult = GscOverviewResult | { ok: false; message: string };

/** The loader's Search Console overview, fetched again when the striking-distance floor changes. */
function useGscOverview(loaded: GscResult) {
  const [result, setResult] = useState<GscResult>(loaded);
  const [minImpressions, setMinImpressions] = useState(
    loaded.ok ? loaded.gsc.minImpressions : 10
  );
  useEffect(() => {
    if (!loaded.ok || minImpressions === loaded.gsc.minImpressions) {
      setResult(loaded);
      return;
    }
    let cancelled = false;
    getSeoGscOverview({ minImpressions })
      .then((r) => {
        if (!cancelled) {
          setResult(r);
        }
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) {
          goToLogin(window.location.pathname + window.location.search);
          return;
        }
        if (!cancelled) {
          setResult({ ok: false, message: errorText(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, minImpressions]);
  return {
    gsc: result.ok ? result.gsc : null,
    // Unknown when the read failed: say nothing about the connection then.
    connected: result.ok ? result.connected : true,
    error: result.ok ? null : result.message,
    minImpressions,
    setMinImpressions,
  };
}

const COLUMNS: {
  key: SeoSortKey | null;
  label: string;
  className?: string;
}[] = [
  { key: null, label: "" },
  { key: "pageTitle", label: "Page" },
  { key: "kind", label: "Kind" },
  { key: "status", label: "Status" },
  { key: "seoTitle", label: "SEO title" },
  { key: "description", label: "Description" },
  { key: "index", label: "Index" },
  { key: null, label: "Share image" },
  { key: "clicks", label: "Clicks" },
  { key: "impressions", label: "Impr." },
  { key: "position", label: "Pos." },
  { key: "score", label: "Score" },
  { key: "issues", label: "Issues" },
];

function SeoTable({
  rows,
  gscRange,
  connected,
}: {
  rows: SeoOverviewRow[];
  gscRange: { start: string; end: string } | null;
  connected: boolean;
}) {
  const [sort, setSort] = useState<{ key: SeoSortKey; dir: SortDir }>({
    key: "score",
    dir: "asc",
  });
  const [issuesOnly, setIssuesOnly] = useState(false);
  const shown = useMemo(
    () =>
      sortSeoRows(issuesOnly ? rowsWithIssues(rows) : rows, sort.key, sort.dir),
    [rows, issuesOnly, sort]
  );

  if (!rows.length) {
    return <p className="text-muted-foreground">No pages yet.</p>;
  }
  const toggle = (key: SeoSortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  const dupes = rows.filter((r) => r.duplicateTitle).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-6 text-muted-foreground text-sm">
        <label className="flex items-center gap-2">
          <Switch
            checked={issuesOnly}
            data-testid="seo-issues-only"
            onCheckedChange={setIssuesOnly}
          />
          Issues only
        </label>
        <span
          className="text-muted-foreground"
          data-testid="seo-overview-count"
        >
          {shown.length} of {rows.length} pages
          {dupes > 0 && (
            <span className="text-destructive">
              {" "}
              · {dupes} with a duplicate title
            </span>
          )}
        </span>
        <span
          className={`text-xs ${connected ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}`}
          data-testid="seo-gsc-range"
        >
          {gscRange
            ? `Clicks, impressions and position: Search Console, ${gscRange.start} to ${gscRange.end} (28 days)`
            : connected
              ? "No Search Console data yet"
              : GSC_CONNECT_HINT}
        </span>
      </div>
      <div className="overflow-x-auto rounded border border-border">
        {/* The body's `[overflow-wrap:anywhere]` (__root.tsx) breaks short words mid-word in table
            columns ("pag/e"); here words wrap whole, and only long text and paths break. */}
        <table
          className="w-full text-left text-sm [overflow-wrap:normal]"
          data-testid="seo-overview"
        >
          <thead className="bg-card text-muted-foreground text-xs uppercase tracking-wide">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  aria-sort={
                    c.key && sort.key === c.key
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="whitespace-nowrap px-3 py-3 font-medium"
                  key={c.label}
                >
                  {c.key ? (
                    <button
                      className="flex items-center gap-1 uppercase hover:text-foreground"
                      data-testid={`seo-sort-${c.key}`}
                      onClick={() => toggle(c.key!)}
                      type="button"
                    >
                      {c.label}
                      {sort.key === c.key &&
                        (sort.dir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        ))}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS_CLASS: Record<SeoOverviewRow["status"], string> = {
  draft: "bg-accent text-foreground",
  published:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-700 dark:text-emerald-300",
};

function Row({ row: r }: { row: SeoOverviewRow }) {
  const scoreClass =
    r.score >= 80
      ? "text-emerald-700 dark:text-emerald-300"
      : r.score >= 50
        ? "text-amber-700 dark:text-amber-300"
        : "text-destructive";
  const size =
    r.shareImage.width && r.shareImage.height
      ? `${r.shareImage.width}×${r.shareImage.height}`
      : null;
  return (
    <tr
      className="border-border border-t align-top hover:bg-card"
      data-path={r.path}
      data-testid="seo-overview-row"
    >
      <td className="w-8 py-3 pl-3">
        <RowCheckbox row={r} />
      </td>
      <td className="min-w-40 px-3 py-3 [overflow-wrap:break-word]">
        <Link
          className="font-medium text-foreground hover:text-primary"
          data-testid="seo-row-link"
          hash="seo"
          params={{ pageId: r.id }}
          to="/admin/editor/$pageId"
        >
          {r.pageTitle}
        </Link>
        <div className="font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]">
          {r.path}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
        {r.kind}
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <span
          className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[r.status]}`}
        >
          {r.status}
        </span>
      </td>
      <td className="min-w-36 max-w-64 px-3 py-3 [overflow-wrap:break-word]">
        <span
          className={r.duplicateTitle ? "text-destructive" : "text-foreground"}
        >
          {r.seoTitle}
        </span>
        {!!r.duplicateTitle && (
          <span
            className="mt-1 flex items-center gap-1 text-destructive text-xs"
            data-testid="seo-dup-title"
          >
            <Copy className="h-3 w-3" /> Duplicate title
          </span>
        )}
      </td>
      <td className="min-w-40 max-w-72 px-3 py-3 [overflow-wrap:break-word]">
        <span
          className={`line-clamp-3 ${r.description ? "text-muted-foreground" : "text-muted-foreground italic"}`}
        >
          {r.description || "No description"}
        </span>
        {!!r.duplicateDescription && (
          <span
            className="mt-1 flex items-center gap-1 text-amber-700 dark:text-amber-300 text-xs"
            data-testid="seo-dup-description"
          >
            <Copy className="h-3 w-3" /> Duplicate description
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs">
        {r.index ? (
          <span className="text-emerald-700 dark:text-emerald-300">index</span>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">noindex</span>
        )}
        <div className="text-muted-foreground">
          {r.sitemap ? "in sitemap" : "not in sitemap"}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <img
          alt=""
          className="h-[42px] w-20 rounded border border-border object-cover"
          height={42}
          loading="lazy"
          src={r.shareImage.src}
          width={80}
        />
        <div className="mt-1 text-[11px] text-muted-foreground">
          {r.shareImage.isDefault ? "site default" : (size ?? "size unknown")}
        </div>
      </td>
      <td
        className="whitespace-nowrap px-3 py-3 text-right text-foreground tabular-nums"
        data-testid="seo-row-clicks"
      >
        {r.gsc ? (
          fmtInt(r.gsc.clicks)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right text-muted-foreground tabular-nums">
        {r.gsc ? (
          fmtInt(r.gsc.impressions)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right text-muted-foreground tabular-nums">
        {r.gsc ? (
          fmtPosition(r.gsc.position)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td
        className={`whitespace-nowrap px-3 py-3 font-bold font-heading text-lg ${scoreClass}`}
        data-testid="seo-row-score"
      >
        {r.score}
      </td>
      <td className="px-3 py-3 text-xs">
        {r.issues.length ? (
          <details>
            <summary className="cursor-pointer whitespace-nowrap text-muted-foreground">
              {r.fails > 0 && (
                <span className="mr-2 inline-flex items-center gap-1 text-destructive">
                  <CircleX className="h-3 w-3" /> {r.fails}
                </span>
              )}
              {r.warns > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="h-3 w-3" /> {r.warns}
                </span>
              )}
            </summary>
            <ul className="mt-2 flex w-72 flex-col gap-1 whitespace-normal [overflow-wrap:break-word]">
              {r.issues.map((i) => (
                <li
                  className={
                    i.status === "fail"
                      ? "text-destructive"
                      : "text-amber-700 dark:text-amber-300"
                  }
                  key={i.id}
                >
                  <IssueCheckbox issueId={i.id} pageId={r.id} />
                  <span className="font-medium">{i.label}:</span>{" "}
                  <span className="text-muted-foreground">{i.message}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <span className="text-emerald-700 dark:text-emerald-300">None</span>
        )}
      </td>
    </tr>
  );
}
