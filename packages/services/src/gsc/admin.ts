import {
  GSC_CONNECT_HINT,
  type PagePerformance,
  pageUrl,
  type SeoGscOverview,
} from "@repo/cms-core/gsc/shape";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { DEFAULT_MIN_IMPRESSIONS, type PageUrl } from "@repo/db/gsc";

import { type Clock, systemClock } from "../clock";
import { adminResult } from "../cms/admin-errors";
import type { AdminResult, PageStatus } from "../cms/admin-result";
import { CmsError } from "../cms/pages-service";
import { type GscClient, GscError } from "./client";
import { type GscStore, inspectPages } from "./sync";

/**
 * The admin's Search Console calls. The reads only touch D1 (the cron and scripts fill it), so
 * opening the SEO tab never spends API quota; "Inspect now" and "Resubmit sitemap" are the two
 * that call Google, on a click. The reads also say whether Search Console is connected
 * (`connected`: a client was passed), so the UI can tell "not connected" apart from "no data yet".
 * Admin gating is the caller's; input checks throw (the promise rejects).
 */

/** `@repo/db/gsc`'s reads with the database bound. */
export type GscQueries = {
  pagePerformance: (
    page: { id: string; slug: string },
    days: number,
    opts: { pageUrl: PageUrl; now?: number }
  ) => Promise<PagePerformance>;
  seoGscOverview: (opts: {
    pageUrl: PageUrl;
    minImpressions?: number;
    now?: number;
  }) => Promise<SeoGscOverview>;
};

/** The page lookup the calls need; `CmsRepo.findPage` (`createD1Repo(db)`) fits. */
export type GscPageLookup = {
  findPage: (ref: {
    id: string;
  }) => Promise<{ id: string; slug: string; status: PageStatus } | null>;
};

export type GscAdminDeps = {
  queries: GscQueries;
  pages: GscPageLookup;
  store: GscStore;
  /** null when Search Console isn't connected (secrets or `config.gscProperty` missing). */
  client: GscClient | null;
  config: Pick<SiteConfig, "origin">;
  clock?: Clock;
  log?: (message: string) => void;
};

export const PERFORMANCE_DAYS = [28, 90] as const;
export type PerformanceDays = (typeof PERFORMANCE_DAYS)[number];

const MAX_PAGE_ID_LENGTH = 64;
const MAX_MIN_IMPRESSIONS = 1_000_000;

const urlOf =
  (config: Pick<SiteConfig, "origin">): PageUrl =>
  (slug) =>
    pageUrl(slug, config);

function checkPageId(pageId: unknown): asserts pageId is string {
  if (typeof pageId !== "string" || pageId.length > MAX_PAGE_ID_LENGTH) {
    throw new Error('Expected "pageId" to be a string');
  }
}

/** The SEO tab's "Search performance" for one page over 28 or 90 days. */
export async function getPagePerformance(
  d: GscAdminDeps,
  input: { pageId: string; days: number }
): Promise<AdminResult<{ performance: PagePerformance; connected: boolean }>> {
  const { pageId, days } = input;
  checkPageId(pageId);
  if (!PERFORMANCE_DAYS.includes(days as PerformanceDays)) {
    throw new Error('Expected "days" to be 28 or 90');
  }
  return await adminResult(async () => {
    const page = await d.pages.findPage({ id: pageId });
    if (!page) {
      throw new CmsError("NOT_FOUND", `Page ${pageId} not found`);
    }
    return {
      performance: await d.queries.pagePerformance(
        { id: page.id, slug: page.slug },
        days,
        {
          pageUrl: urlOf(d.config),
          now: (d.clock ?? systemClock)().getTime(),
        }
      ),
      connected: d.client !== null,
    };
  });
}

/** /admin/seo: 28-day clicks/impressions/position per page and the Opportunities lists. */
export async function getSeoGscOverview(
  d: GscAdminDeps,
  input: { minImpressions?: number } = {}
): Promise<AdminResult<{ gsc: SeoGscOverview; connected: boolean }>> {
  const min = input.minImpressions ?? DEFAULT_MIN_IMPRESSIONS;
  if (
    typeof min !== "number" ||
    !Number.isInteger(min) ||
    min < 0 ||
    min > MAX_MIN_IMPRESSIONS
  ) {
    throw new Error('Expected "minImpressions" to be a whole number');
  }
  return await adminResult(async () => ({
    gsc: await d.queries.seoGscOverview({
      pageUrl: urlOf(d.config),
      minImpressions: min,
      now: (d.clock ?? systemClock)().getTime(),
    }),
    connected: d.client !== null,
  }));
}

/** The Google calls' result: Search Console failures are shown, not thrown. */
export type GscActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; message: string };

async function gscAction<T extends object>(
  client: GscClient | null,
  fn: (client: GscClient) => Promise<T>
): Promise<GscActionResult<T>> {
  if (!client) {
    return { ok: false, message: GSC_CONNECT_HINT };
  }
  try {
    return { ok: true, ...(await fn(client)) };
  } catch (err) {
    if (!(err instanceof GscError)) {
      throw err;
    }
    return { ok: false, message: err.message };
  }
}

/**
 * Not indexed → "Inspect now": a fresh URL Inspection of one published page, stored like the
 * nightly ones. It refreshes what Google reports; it doesn't ask Google to crawl.
 */
export async function inspectPageNow(
  d: GscAdminDeps,
  input: { pageId: string }
): Promise<GscActionResult<{ inspected: boolean }>> {
  const { pageId } = input;
  checkPageId(pageId);
  const page = await d.pages.findPage({ id: pageId });
  if (!page) {
    return { ok: false, message: `Page ${pageId} not found` };
  }
  if (page.status !== "published") {
    return { ok: false, message: "Only published pages can be inspected." };
  }
  return await gscAction(d.client, async (client) => {
    const summary = await inspectPages(
      { store: d.store, client, clock: d.clock, log: d.log },
      [pageUrl(page.slug, d.config)]
    );
    const code = summary.stopped ?? summary.failed.at(0)?.code;
    if (code) {
      throw new GscError(
        code,
        "Search Console couldn't inspect the page right now. Try again later."
      );
    }
    return { inspected: true };
  });
}

/** The sitemap Search Console is told about. */
export const sitemapUrl = (config: Pick<SiteConfig, "origin">) =>
  `${config.origin}/sitemap.xml`;

const SCOPE_ERROR_RE = /insufficient|scope/i;

/** Not indexed → "Resubmit sitemap": tells Google the sitemap changed. Needs the full `webmasters` scope. */
export async function submitSitemap(
  d: Pick<GscAdminDeps, "client" | "config">
): Promise<GscActionResult> {
  const result = await gscAction(d.client, async (client) => {
    await client.submitSitemap(sitemapUrl(d.config));
    return {};
  });
  if (!result.ok && SCOPE_ERROR_RE.test(result.message)) {
    return {
      ok: false,
      message:
        "The Search Console sign-in is read-only. Run `bun run gsc:auth` again (it asks for write access now) and update GSC_REFRESH_TOKEN.",
    };
  }
  return result;
}

/** The Search Console admin with its ports bound. */
export const createGscAdmin = (deps: GscAdminDeps) => ({
  pagePerformance: (input: Parameters<typeof getPagePerformance>[1]) =>
    getPagePerformance(deps, input),
  seoOverview: (input?: Parameters<typeof getSeoGscOverview>[1]) =>
    getSeoGscOverview(deps, input),
  inspectPageNow: (input: Parameters<typeof inspectPageNow>[1]) =>
    inspectPageNow(deps, input),
  submitSitemap: () => submitSitemap(deps),
});
