import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Sign-in and consent for MCP clients that connect with OAuth (src/server/mcp/authorize.ts).
 * Unlike the library's other endpoints (answered in src/server.ts) this one goes through Clerk,
 * because it needs the admin session. Modules load inside the handler, so public pages never pull
 * them in.
 */
async function handle({ request }: { request: Request }): Promise<Response> {
  const [{ handleAuthorize }, { checkAdmin }, { cmsServices }] =
    await Promise.all([
      import("#/server/mcp/authorize"),
      import("#/server/cms/admin"),
      import("#/server/cms/wiring"),
    ]);
  const services = cmsServices(env, { request });
  return handleAuthorize(request, {
    env,
    connections: services.connections,
    siteName: services.config.name,
    check: checkAdmin,
  });
}

/**
 * Document requests always reach the server handlers. After sign-in, Clerk's <SignIn> may return
 * here with a client-side navigation instead, which the server never sees: reload, so it does.
 */
function ReloadFromServer() {
  useEffect(() => window.location.reload(), []);
  return null;
}

export const Route = createFileRoute("/oauth/authorize")({
  server: {
    handlers: { GET: handle, POST: handle },
  },
  component: ReloadFromServer,
});
