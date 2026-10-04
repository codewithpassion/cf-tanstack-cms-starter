import { env } from "cloudflare:workers";
import { createMiddleware } from "@tanstack/react-start";
import { cmsServices } from "../cms/wiring.ts";
import {
  agentRenderDeps,
  checkAgentRenderRequest,
  markUncacheable,
} from "./og-render-agent.ts";

/**
 * Request middleware of `/og-render-agent/<pageId>` (routes/og-render-agent.$pageId.tsx): runs
 * before the route renders and answers 403 itself (og-render-agent.ts `checkAgentRenderRequest`).
 * Successful responses are marked no-store and noindex. Only the route's `server` block imports
 * it, which is stripped from client bundles.
 */
export const agentRenderGate = createMiddleware({ type: "request" }).server(
  async ({ request, next }) => {
    const denied = await checkAgentRenderRequest(
      agentRenderDeps(cmsServices(env, { request })),
      new URL(request.url)
    );
    if (denied) {
      return denied;
    }
    const result = await next();
    markUncacheable(result.response);
    return result;
  }
);
