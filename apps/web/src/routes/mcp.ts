import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

/**
 * The CMS MCP server: Streamable HTTP at `/mcp`, for Claude Code and other MCP clients.
 * Authenticated with `Authorization: Bearer <API key or OAuth token>` only (no cookies, so the
 * CSRF check doesn't apply, and Clerk is skipped for this path: src/lib/clerk-skip.ts). The MCP
 * modules load inside the handler, so public pages never pull them in.
 */
async function handle({ request }: { request: Request }): Promise<Response> {
  const { handleMcpRequest } = await import("#/server/mcp/handler");
  return handleMcpRequest(env, request);
}

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: { GET: handle, POST: handle, DELETE: handle },
  },
});
