import { cmsServices } from "../cms/wiring";

/**
 * The daily cron's MCP step (src/server.ts `scheduled`): deletes `mcp_calls` rows older than 90
 * days. Runs on its own, next to the Search Console run: neither one's failure skips the other.
 * Returns the error message on failure (logged here) so the caller can fail the run at the end.
 */
export async function pruneMcpCallsDaily(
  env: Env,
  now = Date.now()
): Promise<string | null> {
  try {
    const deleted = await cmsServices(env).apiKeys.pruneCalls(now);
    console.log(JSON.stringify({ mcpCalls: "pruned", deleted }));
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ mcpCalls: "failed", error: message }));
    return message;
  }
}
