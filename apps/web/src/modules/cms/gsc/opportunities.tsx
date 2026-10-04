// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: false positives on nullable verdict labels (`v` is null for never-inspected pages).
// biome-ignore-all lint/suspicious/noLeakedRender: false positive on a string ternary.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim; admin-only tables, not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
import { fmtInt, fmtPosition, verdictLabel } from "@repo/cms-core/gsc/format";
import {
  GSC_CONNECT_HINT,
  type SeoGscOverview,
  STRIKING_MAX_POSITION,
  STRIKING_MIN_POSITION,
} from "@repo/cms-core/gsc/shape";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { goToLogin, isUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";

import { OpportunityCheckbox } from "../seo/fix-selection";
import { useSiteConfig } from "../site/site-context";

const gscActions = () => getTrpc().cms.gsc;

const signInAgain = (err: unknown): boolean => {
  if (!isUnauthorized(err)) {
    return false;
  }
  goToLogin(window.location.pathname + window.location.search);
  return true;
};

/**
 * /admin/seo → Opportunities (docs/cms-plan.md §3.10), both computed in SQL from D1:
 * - striking distance: queries averaging position 4–20 over 28 days with enough impressions,
 *   grouped by page (CMS or not: code-built pages rank too);
 * - not indexed: published, indexable CMS pages whose latest URL Inspection isn't PASS.
 * CMS pages in either list can be picked for "Fix with agent". Google has no API to request a crawl of an ordinary page, so "not indexed" offers what there is:
 * a fresh inspection, a link to Search Console's URL Inspection (where "Request indexing" is a
 * button), and resubmitting the sitemap. Without the GSC secrets (`connected` false) the two
 * buttons are disabled and say how to connect.
 */

export const MIN_IMPRESSION_CHOICES = [1, 5, 10, 25, 50, 100];

const pathOf = (url: string, origin: string) =>
  url.startsWith(origin) ? url.slice(origin.length) || "/" : url;
const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

function PageLink({
  pageId,
  url,
  label,
}: {
  pageId: string | null;
  url: string;
  label?: string;
}) {
  const { origin } = useSiteConfig();
  return pageId ? (
    <Link
      to="/admin/editor/$pageId"
      params={{ pageId }}
      hash="seo"
      className="font-medium text-foreground hover:text-primary"
    >
      {label ?? pathOf(url, origin)}
    </Link>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
    >
      {label ?? pathOf(url, origin)} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** Search Console's URL Inspection for one page, where "Request indexing" is. */
export const inspectInConsoleUrl = (
  config: Pick<SiteConfig, "gscProperty" | "origin">,
  url: string
) =>
  `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(config.gscProperty ?? `${config.origin}/`)}&id=${encodeURIComponent(url)}`;

function InspectNow({
  pageId,
  connected,
}: {
  pageId: string;
  connected: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const run = async () => {
    setState({ busy: true, error: null });
    try {
      const res = await gscActions().inspectPageNow.mutate({ pageId });
      if (!res.ok) {
        setState({ busy: false, error: res.message });
        return;
      }
      setState({ busy: false, error: null });
      await router.invalidate();
    } catch (err) {
      if (signInAgain(err)) {
        return;
      }
      setState({
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={state.busy || !connected}
        onClick={() => void run()}
        title={
          connected
            ? "Ask Search Console for this page's current status (it doesn't trigger a crawl)"
            : GSC_CONNECT_HINT
        }
        data-testid="seo-inspect-now"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${state.busy ? "animate-spin" : ""}`}
        />{" "}
        Inspect now
      </Button>
      {!!state.error && (
        <div className="mt-1 max-w-56 text-xs text-destructive">
          {state.error}
        </div>
      )}
    </>
  );
}

function ResubmitSitemap({ connected }: { connected: boolean }) {
  const [state, setState] = useState<{
    busy: boolean;
    note: string | null;
    error: boolean;
  }>({ busy: false, note: null, error: false });
  const run = async () => {
    setState({ busy: true, note: null, error: false });
    try {
      const res = await gscActions().submitSitemap.mutate();
      setState({
        busy: false,
        note: res.ok
          ? "Sitemap resubmitted. Google reads it again within a day or so."
          : res.message,
        error: !res.ok,
      });
    } catch (err) {
      if (signInAgain(err)) {
        return;
      }
      setState({
        busy: false,
        note: err instanceof Error ? err.message : String(err),
        error: true,
      });
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={state.busy || !connected}
        onClick={() => void run()}
        title={connected ? undefined : GSC_CONNECT_HINT}
        data-testid="seo-resubmit-sitemap"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${state.busy ? "animate-spin" : ""}`}
        />{" "}
        Resubmit sitemap
      </Button>
      {!!state.note && (
        <span
          className={`max-w-80 text-right text-xs ${state.error ? "text-destructive" : "text-emerald-700 dark:text-emerald-300"}`}
        >
          {state.note}
        </span>
      )}
    </div>
  );
}

export function Opportunities({
  gsc,
  connected,
  minImpressions,
  onMinImpressions,
}: {
  gsc: SeoGscOverview;
  connected: boolean;
  minImpressions: number;
  onMinImpressions: (n: number) => void;
}) {
  const config = useSiteConfig();
  const queries = gsc.striking.reduce((n, p) => n + p.queries.length, 0);
  return (
    <div className="flex flex-col gap-8" data-testid="seo-opportunities">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-heading text-lg font-bold">
              Striking distance
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Queries ranking {STRIKING_MIN_POSITION}–{STRIKING_MAX_POSITION} on
              average
              {gsc.range
                ? ` from ${shortDate(gsc.range.start)} to ${shortDate(gsc.range.end)}`
                : ""}
              : close to the first page or the top 3, where better titles,
              descriptions and content pay off most.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            At least
            <select
              value={minImpressions}
              onChange={(e) => onMinImpressions(Number(e.target.value))}
              className="rounded border border-border bg-background px-2 py-1"
              data-testid="seo-min-impressions"
            >
              {MIN_IMPRESSION_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            impressions
          </label>
        </div>
        {gsc.range ? (
          gsc.striking.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No queries in striking distance with at least {minImpressions}{" "}
              impressions.
            </p>
          ) : (
            <>
              <p
                className="text-xs text-muted-foreground"
                data-testid="seo-striking-count"
              >
                {queries} {queries === 1 ? "query" : "queries"} on{" "}
                {gsc.striking.length}{" "}
                {gsc.striking.length === 1 ? "page" : "pages"}
              </p>
              <div className="overflow-x-auto rounded border border-border">
                {/* The body's `[overflow-wrap:anywhere]` breaks short words mid-word in table cells. */}
                <table
                  className="w-full text-left text-sm [overflow-wrap:normal]"
                  data-testid="seo-striking"
                >
                  <thead className="bg-card text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Query</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Impressions
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Clicks
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Avg position
                      </th>
                    </tr>
                  </thead>
                  {gsc.striking.map((p) => (
                    <tbody
                      key={p.page}
                      data-testid="seo-striking-page"
                      data-page={p.page}
                    >
                      <tr className="border-t border-border bg-card/60">
                        <td className="px-3 py-2" colSpan={4}>
                          {p.pageId ? (
                            <OpportunityCheckbox
                              pageId={p.pageId}
                              kind="striking"
                            />
                          ) : (
                            <span
                              className="mr-2 inline-block w-3.5"
                              title="Built-in pages aren't in the CMS, so the agent can't edit them"
                            />
                          )}
                          <PageLink pageId={p.pageId} url={p.page} />
                          <span className="ml-3 text-xs text-muted-foreground">
                            {fmtInt(p.impressions)}{" "}
                            {p.impressions === 1 ? "impression" : "impressions"}{" "}
                            · {p.pageId ? "CMS page" : "built-in page"}
                          </span>
                        </td>
                      </tr>
                      {p.queries.map((q) => (
                        <tr key={q.query} className="border-t border-border">
                          <td
                            className="px-3 py-1.5 pl-6 text-foreground"
                            data-testid="seo-striking-query"
                          >
                            {q.query}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {fmtInt(q.impressions)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {fmtInt(q.clicks)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-amber-700 dark:text-amber-300">
                            {fmtPosition(q.position)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </>
          )
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="seo-striking-empty"
          >
            {connected ? "No Search Console data yet." : GSC_CONNECT_HINT}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-heading text-lg font-bold">Not indexed</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Published pages that Google's URL Inspection doesn't report as
              indexed (pages set to noindex are left out). The nightly run
              inspects new and republished pages first, then each page weekly.
              Pages first published in the last 3 days show as pending: Google
              usually needs a few days.
            </p>
          </div>
          <ResubmitSitemap connected={connected} />
        </div>
        {!connected && (
          <p
            className="text-sm text-amber-700 dark:text-amber-300"
            data-testid="seo-not-indexed-not-connected"
          >
            {GSC_CONNECT_HINT}
          </p>
        )}
        {gsc.notIndexed.length === 0 ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            Every published page is indexed.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-border">
            <table
              className="w-full text-left text-sm [overflow-wrap:normal]"
              data-testid="seo-not-indexed"
            >
              <thead className="bg-card text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Page</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Coverage</th>
                  <th className="px-3 py-2 font-medium">Last crawl</th>
                  <th className="px-3 py-2 font-medium">Checked</th>
                  <th className="px-3 py-2 font-medium">Recrawl</th>
                </tr>
              </thead>
              <tbody>
                {gsc.notIndexed.map((p) => {
                  const v = p.inspection
                    ? verdictLabel(p.inspection.verdict)
                    : null;
                  return (
                    <tr
                      key={p.pageId}
                      className="border-t border-border align-top"
                      data-testid="seo-not-indexed-row"
                    >
                      <td className="px-3 py-2">
                        <OpportunityCheckbox
                          pageId={p.pageId}
                          kind="notIndexed"
                        />
                        <PageLink
                          pageId={p.pageId}
                          url={p.url}
                          label={p.title}
                        />
                        <div className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {pathOf(p.url, config.origin)}
                        </div>
                      </td>
                      <td
                        className={`px-3 py-2 ${p.pending ? "text-muted-foreground" : (v?.cls ?? "text-muted-foreground")}`}
                        data-testid="seo-not-indexed-status"
                      >
                        {p.pending ? (
                          <span title="First published less than 3 days ago: Google usually takes a few days to index a new page.">
                            Pending (new page)
                          </span>
                        ) : (
                          (v?.label ?? "Not inspected yet")
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {p.inspection?.coverageState ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {p.inspection?.lastCrawl
                          ? new Date(p.inspection.lastCrawl).toLocaleDateString(
                              "en-GB",
                              { dateStyle: "medium" }
                            )
                          : "Never"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {p.inspection
                          ? new Date(p.inspection.checkedAt).toLocaleDateString(
                              "en-GB",
                              { dateStyle: "medium" }
                            )
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col items-start gap-1.5">
                          <InspectNow pageId={p.pageId} connected={connected} />
                          <a
                            href={inspectInConsoleUrl(config, p.url)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            title="Opens URL Inspection in Search Console; click “Request indexing” there"
                            data-testid="seo-request-indexing"
                          >
                            Request indexing{" "}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
