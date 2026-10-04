import type { SiteConfig } from "@repo/cms-core/site/config";

import { type Clock, systemClock } from "../clock";
import type { GscClient } from "./client";
import {
  type GscStore,
  type InspectSummary,
  inspectDuePages,
  recentWindow,
  type SyncSummary,
  syncSearchAnalytics,
} from "./sync";

/** The Cron Trigger that runs `runGscCron` (the web app's wrangler.jsonc `triggers.crons` must list it). */
export const GSC_CRON = "0 18 * * *";

/** Days the daily run re-pulls: data lags 2–3 days and Google revises it after that. */
export const SYNC_DAYS = 10;

export type GscCronDeps = {
  /** null when the GSC secrets or `config.gscProperty` aren't set: the run logs that it skipped. */
  client: GscClient | null;
  store: GscStore;
  config: Pick<SiteConfig, "origin">;
  clock?: Clock;
  /** Gets the run's one structured line (JSON), plus inspection notes. */
  log: (message: string) => void;
};

export type GscCronResult =
  | { gsc: "skipped"; reason: string }
  | {
      gsc: "ok" | "failed";
      sync: SyncSummary | null;
      inspect: InspectSummary | null;
      errors: string[];
    };

/**
 * The daily Search Console run, called from the Worker's `scheduled` handler. Without a client
 * (no GSC secrets or property) it logs that it skipped and does nothing. Steps run independently:
 * a failed pull doesn't skip inspections. Throws at the end when a step failed, so the run shows
 * as failed in the dashboard.
 */
export async function runGscCron(deps: GscCronDeps): Promise<GscCronResult> {
  const { client, store, config, log } = deps;
  if (!client) {
    const skipped: GscCronResult = {
      gsc: "skipped",
      reason:
        "GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN or GSC_PROPERTY is not set",
    };
    log(JSON.stringify(skipped));
    return skipped;
  }
  // One instant for the whole run, as the source took `now` once.
  const at = (deps.clock ?? systemClock)();
  const clock: Clock = () => at;
  const errors: string[] = [];
  const step = async <T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  };
  const sync = await step("sync", () =>
    syncSearchAnalytics(
      { store, client },
      recentWindow(SYNC_DAYS, at.getTime())
    )
  );
  const inspect = await step("inspect", () =>
    inspectDuePages({ store, client, clock, log, config })
  );
  const result: GscCronResult = {
    gsc: errors.length ? "failed" : "ok",
    sync,
    inspect,
    errors,
  };
  log(JSON.stringify(result));
  if (errors.length) {
    throw new Error(`Search Console run failed: ${errors.join("; ")}`);
  }
  return result;
}
