// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; the chart is one SVG and splitting it would make it harder to diff against the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `series[0]` can be missing (this repo sets noUncheckedIndexedAccess, the source does not).
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim; an admin-only panel, not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: the chart's hover readout is a pointer extra; the totals and table carry the same numbers.
// biome-ignore-all lint/a11y/noStaticElementInteractions: as above (the SVG only tracks the pointer for the hover readout).
import type { AdminResult } from "@repo/cms-core/admin-result";
import {
  fmtCtr,
  fmtInt,
  fmtPosition,
  verdictLabel,
} from "@repo/cms-core/gsc/format";
import {
  dateRange,
  GSC_CONNECT_HINT,
  type GscDay,
  type PagePerformance,
  type PublishMarker,
} from "@repo/cms-core/gsc/shape";
import { useEffect, useMemo, useState } from "react";
import { goToLogin, isUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";

type PagePerformanceResult = AdminResult<{
  performance: PagePerformance;
  connected: boolean;
}>;

const getPagePerformance = (input: {
  pageId: string;
  days: 28 | 90;
}): Promise<PagePerformanceResult> =>
  getTrpc().cms.gsc.getPagePerformance.query(input);

/**
 * The SEO tab's "Search performance" (docs/cms-plan.md §3.10): this page's Search Console totals
 * over 28 or 90 days, a daily chart with a marker for each publish, its top queries, and URL
 * Inspection's index status. Loaded lazily by seo-panel.tsx, so the editor chunk doesn't carry it.
 * Reads D1 only (filled daily by the cron); the numbers trail the GSC UI by its 2–3 day lag.
 */

type Metric = "clicks" | "impressions" | "ctr" | "position";

type MetricDef = {
  id: Metric;
  label: string;
  format: (v: number | null) => string;
  color: string;
};

const METRICS: MetricDef[] = [
  {
    id: "clicks",
    label: "Clicks",
    format: (v) => fmtInt(v ?? 0),
    color: "#60a5fa",
  },
  {
    id: "impressions",
    label: "Impressions",
    format: (v) => fmtInt(v ?? 0),
    color: "#a78bfa",
  },
  { id: "ctr", label: "CTR", format: (v) => fmtCtr(v ?? 0), color: "#34d399" },
  {
    id: "position",
    label: "Avg position",
    format: fmtPosition,
    color: "#fbbf24",
  },
];

type PanelState = {
  data: PagePerformance | null;
  connected: boolean;
  error: string | null;
  loading: boolean;
};

export default function PerformancePanel({ pageId }: { pageId: string }) {
  const [days, setDays] = useState<28 | 90>(28);
  const [metric, setMetric] = useState<Metric>("clicks");
  const [state, setState] = useState<PanelState>({
    data: null,
    connected: true,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    getPagePerformance({ pageId, days })
      .then((res) => {
        if (cancelled) {
          return;
        }
        setState(
          res.ok
            ? {
                data: res.performance,
                connected: res.connected,
                error: null,
                loading: false,
              }
            : {
                data: null,
                connected: true,
                error: res.message,
                loading: false,
              }
        );
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) {
          goToLogin(window.location.pathname + window.location.search);
          return;
        }
        if (!cancelled) {
          setState({
            data: null,
            connected: true,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, days]);

  const { data, connected, error, loading } = state;
  const shownMetric = METRICS.find((m) => m.id === metric) ?? METRICS[0];
  return (
    <div className="flex flex-col gap-4 pt-1" data-testid="gsc-performance">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Search performance
        </h3>
        <fieldset
          className="flex rounded border border-border text-xs"
          aria-label="Date range"
        >
          {([28, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              data-testid={`gsc-days-${d}`}
              className={`px-2 py-0.5 ${days === d ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {d} days
            </button>
          ))}
        </fieldset>
      </div>

      {!!error && (
        <p className="text-xs text-destructive">
          Search Console data couldn't be loaded: {error}
        </p>
      )}
      {!data && loading && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
      {!!data && (
        <div className={`flex flex-col gap-4 ${loading ? "opacity-60" : ""}`}>
          <p
            className="break-all font-mono text-[11px] text-muted-foreground"
            data-testid="gsc-url"
          >
            {data.url}
          </p>
          {!connected && (
            <p
              className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
              data-testid="gsc-not-connected"
            >
              {GSC_CONNECT_HINT}
            </p>
          )}
          {data.range && shownMetric ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {METRICS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={metric === m.id}
                    onClick={() => setMetric(m.id)}
                    data-testid={`gsc-total-${m.id}`}
                    className={`rounded border px-2 py-1.5 text-left ${metric === m.id ? "border-border bg-muted" : "border-border bg-background hover:border-border"}`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: m.color }}
                      />
                      {m.label}
                    </div>
                    <div className="font-heading text-lg font-bold text-foreground">
                      {m.format(data.totals[m.id])}
                    </div>
                  </button>
                ))}
              </div>
              <TrendChart
                series={data.series}
                chartEnd={data.chartEnd ?? data.range.end}
                markers={data.markers}
                metric={shownMetric}
              />
              <p className="text-[11px] text-muted-foreground">
                {shortDate(data.range.start)} – {shortDate(data.range.end)}{" "}
                (Search Console days, US Pacific). Search Console data trails by
                2–3 days (shaded: not final yet).
              </p>
              <TopQueries data={data} />
            </>
          ) : connected ? (
            <p
              className="rounded border border-border bg-background p-3 text-xs text-muted-foreground"
              data-testid="gsc-empty"
            >
              No Search Console data yet. The scheduled sync pulls it daily at
              18:00 UTC.
            </p>
          ) : null}
          <IndexStatus data={data} />
        </div>
      )}
    </div>
  );
}

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const W = 352;
const H = 120;
const PAD = { top: 16, bottom: 16, left: 2, right: 2 };

/**
 * A plain SVG line for one metric, with a dashed line per publish day. Position is drawn top = 1.
 * The axis runs on to `chartEnd` (today): those days have no final data yet (shaded), but their
 * publishes still show.
 */
function TrendChart({
  series,
  chartEnd,
  markers,
  metric,
}: {
  series: GscDay[];
  chartEnd: string;
  markers: PublishMarker[];
  metric: MetricDef;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const axis = useMemo(
    () => dateRange(series[0]?.date ?? chartEnd, chartEnd),
    [series, chartEnd]
  );
  const geo = useMemo(() => {
    const values = series.map((d) =>
      metric.id === "position" ? d.position : d[metric.id]
    );
    const present = values.filter((v): v is number => v !== null);
    const lo = metric.id === "position" ? Math.min(...present, 1) : 0;
    const hi = Math.max(
      ...present,
      metric.id === "position" ? lo + 1 : metric.id === "ctr" ? 0.01 : 1
    );
    const x = (i: number) =>
      PAD.left +
      (axis.length > 1
        ? (i / (axis.length - 1)) * (W - PAD.left - PAD.right)
        : 0);
    const span = hi - lo || 1;
    // Lower positions are better, so they go up.
    const y = (v: number) =>
      PAD.top +
      (metric.id === "position" ? (v - lo) / span : 1 - (v - lo) / span) *
        (H - PAD.top - PAD.bottom);
    let path = "";
    for (const [i, v] of values.entries()) {
      if (v === null) {
        continue;
      }
      path += `${path && values[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }
    return { values, x, y, path, lo, hi };
  }, [series, axis, metric.id]);
  const index = new Map(axis.map((date, i) => [date, i]));
  const hoveredDate = hover === null ? null : axis[hover];
  const hoveredValue =
    hover !== null && hover < series.length ? geo.values[hover] : undefined;
  const hoveredMarker = hoveredDate
    ? markers.find((m) => m.date === hoveredDate)
    : undefined;
  const lastData = series.length - 1;
  const firstDay = axis[0] ?? chartEnd;
  const lastDay = axis.at(-1) ?? chartEnd;

  return (
    <div className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded border border-border bg-background"
        role="img"
        aria-label={`${metric.label} per day`}
        data-testid="gsc-chart"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - box.left) / box.width;
          setHover(
            Math.max(
              0,
              Math.min(axis.length - 1, Math.round(frac * (axis.length - 1)))
            )
          );
        }}
      >
        {lastData < axis.length - 1 && (
          <rect
            x={geo.x(lastData)}
            y={PAD.top}
            width={geo.x(axis.length - 1) - geo.x(lastData)}
            height={H - PAD.top - PAD.bottom}
            fill="#262626"
            opacity={0.6}
          />
        )}
        <line
          x1={0}
          x2={W}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="#404040"
          strokeWidth={1}
        />
        {markers.map((m) => {
          const i = index.get(m.date);
          if (i === undefined) {
            return null;
          }
          return (
            <g key={m.date} data-testid="gsc-publish-marker" data-date={m.date}>
              <line
                x1={geo.x(i)}
                x2={geo.x(i)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="var(--color-brand-primary)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={geo.x(i)}
                cy={H - PAD.bottom}
                r={3}
                fill="var(--color-brand-primary)"
              />
            </g>
          );
        })}
        <path
          d={geo.path}
          fill="none"
          stroke={metric.color}
          strokeWidth={1.75}
          strokeLinejoin="round"
        />
        {hover !== null && (
          <line
            x1={geo.x(hover)}
            x2={geo.x(hover)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="#a3a3a3"
            strokeWidth={0.75}
          />
        )}
        <text x={4} y={11} fontSize={9} fill="#737373">
          {metric.id === "position"
            ? `pos ${metric.format(geo.lo)}`
            : `max ${metric.format(geo.hi)}`}
        </text>
        <text x={4} y={H - 4} fontSize={9} fill="#737373">
          {shortDate(firstDay)}
        </text>
        <text x={W - 4} y={H - 4} textAnchor="end" fontSize={9} fill="#737373">
          {shortDate(lastDay)}
        </text>
      </svg>
      <div
        className="flex min-h-4 items-center justify-between gap-2 text-[11px] text-muted-foreground"
        data-testid="gsc-chart-hover"
      >
        {hoveredDate ? (
          <>
            <span>
              {shortDate(hoveredDate)}:{" "}
              {hoveredValue === undefined
                ? "no final data yet"
                : metric.format(hoveredValue)}
            </span>
            {!!hoveredMarker && (
              <span className="truncate text-primary">
                Published
                {hoveredMarker.count > 1 ? ` ×${hoveredMarker.count}` : ""}
                {hoveredMarker.labels.length
                  ? ` · ${hoveredMarker.labels.join(", ")}`
                  : ""}
              </span>
            )}
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-3 border-t border-dashed border-primary" />{" "}
            {markers.length
              ? `${markers.length} publish day${markers.length === 1 ? "" : "s"}`
              : "No publishes in range"}
          </span>
        )}
      </div>
    </div>
  );
}

function TopQueries({ data }: { data: PagePerformance }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Top queries
      </h4>
      {data.topQueries.length ? (
        // The body's `[overflow-wrap:anywhere]` breaks short words mid-word in table cells.
        <table
          className="w-full text-xs [overflow-wrap:normal]"
          data-testid="gsc-top-queries"
        >
          <thead className="text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="pb-1 text-left font-medium">Query</th>
              <th className="pb-1 text-right font-medium">Clicks</th>
              <th className="pb-1 text-right font-medium">Impr.</th>
              <th className="pb-1 text-right font-medium">Pos.</th>
            </tr>
          </thead>
          <tbody>
            {data.topQueries.map((q) => (
              <tr key={q.query} className="border-t border-border">
                <td
                  className="max-w-0 truncate py-1 pr-2 text-foreground"
                  title={q.query}
                  data-testid="gsc-query"
                >
                  {q.query}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {fmtInt(q.clicks)}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {fmtInt(q.impressions)}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {fmtPosition(q.position)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">
          No queries in this range. Google leaves out rare (anonymised) queries,
          so the totals above can be higher.
        </p>
      )}
    </section>
  );
}

function IndexStatus({ data }: { data: PagePerformance }) {
  const i = data.inspection;
  const verdict = i ? verdictLabel(i.verdict) : null;
  const canonicalDiffers =
    !!i?.googleCanonical && i.googleCanonical !== data.url;
  return (
    <section className="flex flex-col gap-2" data-testid="gsc-index-status">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Index status
      </h4>
      {i && verdict ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Verdict</dt>
          <dd className={verdict.cls} data-testid="gsc-verdict">
            {verdict.label}
          </dd>
          <dt className="text-muted-foreground">Coverage</dt>
          <dd className="text-muted-foreground">{i.coverageState ?? "—"}</dd>
          <dt className="text-muted-foreground">Last crawl</dt>
          <dd className="text-muted-foreground">
            {i.lastCrawl
              ? new Date(i.lastCrawl).toLocaleString("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "Never"}
          </dd>
          <dt className="text-muted-foreground">Google canonical</dt>
          <dd
            className={`break-all ${canonicalDiffers ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
          >
            {i.googleCanonical ?? "—"}
            {!!canonicalDiffers && (
              <span className="block text-[11px]">
                Google picked a different URL than this page.
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">Checked</dt>
          <dd className="text-muted-foreground">
            {new Date(i.checkedAt).toLocaleString("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </dd>
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">
          Not inspected yet. The nightly run inspects published CMS pages: new
          and republished ones first, then each weekly.
        </p>
      )}
    </section>
  );
}
