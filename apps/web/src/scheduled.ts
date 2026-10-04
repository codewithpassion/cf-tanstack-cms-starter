import { pruneMcpCallsDaily } from "./server/adapters/cron-mcp.ts";

/** The daily trigger in wrangler.jsonc `triggers.crons`. A cron added later for something else won't run it. */
export const DAILY_CRON = "0 18 * * *";

export async function scheduled(
  controller: ScheduledController,
  env: Env
): Promise<void> {
  if (controller.cron !== DAILY_CRON) {
    console.log(
      JSON.stringify({ cron: controller.cron, scheduled: "ignored" })
    );
    return;
  }
  // TODO(cms-port-gsc): the daily Search Console pull and URL inspection (services/gsc) run
  // here, as an independent step next to the cleanup, once Phase 2B has landed.
  const pruneError = await pruneMcpCallsDaily(env);
  if (pruneError) {
    throw new Error(`MCP call log cleanup failed: ${pruneError}`);
  }
}
