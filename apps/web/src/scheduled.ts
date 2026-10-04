import { GSC_CRON } from "@repo/services/gsc/cron";
import { runGscDaily } from "./server/adapters/cron-gsc.ts";
import { pruneMcpCallsDaily } from "./server/adapters/cron-mcp.ts";

/** The daily trigger in wrangler.jsonc `triggers.crons`. A cron added later for something else won't run it. */
export const DAILY_CRON = GSC_CRON;

/**
 * The Worker's `scheduled` handler (src/server.ts). Two independent steps: a failed MCP call-log
 * cleanup doesn't skip Search Console, and the other way round. The run fails at the end when
 * either step failed (a Search Console error first, as thrown), so it shows as failed in the
 * dashboard.
 */
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
  const pruneError = await pruneMcpCallsDaily(env);
  await runGscDaily(env);
  if (pruneError) {
    throw new Error(`MCP call log cleanup failed: ${pruneError}`);
  }
}
