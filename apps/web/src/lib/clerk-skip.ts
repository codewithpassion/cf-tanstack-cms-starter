/**
 * Requests that skip Clerk in both layers (the Hono app in src/server.ts and Start's request
 * middleware in src/start.ts): public media (`/media/<sha256>.<ext>`), cookieless and cached as
 * immutable; the share-image render target (`/og-render*`), which Browser Run loads without
 * cookies and which checks its own token (in a dev instance Clerk would answer a cookieless
 * document request with a 307 to its handshake, which would end up in the screenshot); and `/mcp`
 * (exactly), the CMS MCP server, called by MCP clients with a bearer API key and no cookies.
 */
export const skipsClerk = (pathname: string): boolean =>
  pathname.startsWith("/media/") ||
  pathname === "/og-render" ||
  pathname.startsWith("/og-render/") ||
  pathname.startsWith("/og-render-agent/") ||
  pathname === "/mcp";
