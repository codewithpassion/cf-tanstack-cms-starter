import { type GscCronResult, runGscCron } from "@repo/services/gsc/cron";
import { createD1GscStore } from "@repo/services/gsc/d1";
import { createDb, resolveSiteConfig } from "../cms/wiring";
import { gscClientFor } from "./gsc";

/**
 * The daily cron's Search Console step (src/scheduled.ts; `bun run gsc:sync` runs it locally):
 * re-pulls the last 10 days and inspects the published pages that are due (`runGscCron`).
 * Without the GSC secrets or `GSC_PROPERTY` it logs that it skipped, before the site config is
 * read, so an unconfigured deployment never fails here. Throws when a step failed.
 */
export function runGscDaily(
  env: Env,
  now: number = Date.now()
): Promise<GscCronResult> {
  const client = gscClientFor(env);
  const log = (message: string) => console.log(message);
  const store = createD1GscStore(createDb(env));
  const clock = () => new Date(now);
  if (!client) {
    return runGscCron({ client, store, config: { origin: "" }, clock, log });
  }
  // Inspections are of the public URLs: SITE_ORIGIN must be set (D16; throws when empty).
  const config = resolveSiteConfig(env, null);
  return runGscCron({ client, store, config, clock, log });
}
