import type { createAgentAdminService } from "@repo/services/agent/admin-service";
import type { AltSuggestion } from "@repo/services/agent/alt-text";
import type { Context } from "../../context.ts";

/**
 * What the `agent` and `agentRuns` routers need from the agent runtime (server/cms/agent-runtime.ts):
 * the admin service bound to the signed-in admin, and the alt-text call. The routers take a loader
 * for it, so tests hand them a fake built over the services' memory store and the real one stays a
 * dynamic import (the runtime pulls in `cloudflare:workers` and the model SDKs).
 */
export type AgentApi = {
  admin: ReturnType<typeof createAgentAdminService>;
  suggestAltText: (mediaId: string, context?: string) => Promise<AltSuggestion>;
};

/** The context after `adminProcedure`: the admin's id and matched email are set. */
export type AdminCtx = Pick<Context, "services"> & {
  userId: string;
  adminEmail: string;
};

export type AgentApiLoader = (ctx: AdminCtx) => Promise<AgentApi>;

// One runtime per request: `ctx.services.cms` is built per request (context.ts), so it keys the memo.
const runtimes = new WeakMap<object, Promise<AgentApi>>();

const loadRuntime = async (ctx: AdminCtx): Promise<AgentApi> => {
  // Loaded here, not at the top, so tests can import the routers without the Workers runtime.
  const [{ env }, { agentRuntime }] = await Promise.all([
    import("cloudflare:workers"),
    import("../../../cms/agent-runtime.ts"),
  ]);
  return agentRuntime(env, ctx.services.cms, {
    actor: { userId: ctx.userId, email: ctx.adminEmail },
  });
};

/** The real loader: `agentRuntime(env, cms, { actor })`, built once per request. */
export const agentApiFor: AgentApiLoader = (ctx) => {
  const key = ctx.services.cms;
  let api = runtimes.get(key);
  if (!api) {
    api = loadRuntime(ctx);
    runtimes.set(key, api);
  }
  return api;
};
