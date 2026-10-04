#!/usr/bin/env bun
/**
 * The daily Search Console run against the LOCAL D1: re-pulls the last 10 days and runs URL
 * Inspection for the local published CMS pages that are due, exactly as the production cron does
 * (src/server/adapters/cron-gsc.ts). Credentials come from .env.local, the property from the
 * GSC_PROPERTY var; without them it logs that it skipped. Pages are inspected at their SITE_ORIGIN
 * URL (set it in .env.local), so pages that only exist locally come back as unknown to Google.
 * Each inspection spends one of the property's 2,000 a day.
 *
 *   bun run gsc:sync
 *
 * Stop the dev server first if D1 reports SQLITE_BUSY.
 */
import { getPlatformProxy } from "wrangler";

import { runGscDaily } from "../src/server/adapters/cron-gsc.ts";

const { env, dispose } = await getPlatformProxy<Env>({
  configPath: "wrangler.jsonc",
  persist: { path: ".wrangler/state/v3" },
  remoteBindings: false,
});
try {
  await runGscDaily(env);
} finally {
  await dispose();
}
