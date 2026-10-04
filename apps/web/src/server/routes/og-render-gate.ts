import { env } from "cloudflare:workers";
import { createMiddleware } from "@tanstack/react-start";
import { checkOgRequest, markUncacheable } from "./og-render.ts";

/**
 * Request middleware of `/og-render/*` (routes/og-render.$.tsx): runs before the route renders and
 * answers 403/400 itself (og-render.ts `checkOgRequest`). Successful responses are marked no-store
 * and noindex. Only the route's `server` block imports it, which is stripped from client bundles.
 */
export const ogTokenGate = createMiddleware({ type: "request" }).server(
  async ({ request, next }) => {
    const denied = await checkOgRequest(
      { signingKey: env.PREVIEW_SIGNING_KEY },
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
