import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { OAUTH_SCOPES } from "@repo/services/mcp/scopes";

/**
 * The MCP server's OAuth authorization server, from `@cloudflare/workers-oauth-provider` v1, in
 * this Worker. Claude.ai, Claude Desktop and other MCP clients sign in with the admin login and
 * get a token for `<origin>/mcp`.
 *
 * - The issuer is the request's origin, so production and local dev (`http://localhost:3000`,
 *   which the library allows on loopback) each run their own: a token only works on the host that
 *   issued it. The issuer and resource are fixed at construction, so there is one instance per
 *   origin. The library refuses plain http on any other host (e.g. a Tailscale dev origin):
 *   there `/mcp` takes API keys only and the OAuth endpoints are 404.
 * - Clients: Client ID Metadata Documents (needs the `global_fetch_strictly_public` compatibility
 *   flag) and Dynamic Client Registration.
 * - The library serves `/.well-known/oauth-authorization-server`, `/oauth/token` (also revocation)
 *   and `/oauth/register`, answered in src/server.ts before Clerk and TanStack. `/oauth/authorize`
 *   is ours (src/routes/oauth.authorize.tsx, ./authorize.ts), behind Clerk. `/mcp` and its RFC 9728
 *   metadata are the resource server in ./handler.ts.
 * - Storage: OAUTH_KV. Tokens and codes are stored hashed, props encrypted.
 * - Revoking a connection is `connections.revoke(grants, id)` in @repo/services over the grants
 *   adapter (server/adapters/oauth-grants.ts), which wraps `authorizationServerFor`.
 */

export const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTER_PATH = "/oauth/register";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
const PRM_PREFIX = "/.well-known/oauth-protected-resource";

export const mcpResourceFor = (origin: string) => `${origin}/mcp`;

/** The cookieless endpoints the library answers itself. */
const isAuthorizationServerPath = (pathname: string) =>
  pathname === AS_METADATA_PATH ||
  pathname === TOKEN_PATH ||
  pathname === REGISTER_PATH;

/** RFC 9728 protected resource metadata (`/.well-known/oauth-protected-resource/mcp`), served by the resource server. */
const isProtectedResourceMetadataPath = (pathname: string) =>
  pathname === PRM_PREFIX || pathname.startsWith(`${PRM_PREFIX}/`);

const servers = new Map<string, OAuthAuthorizationServer<Env> | null>();

/** This origin's authorization server, or null where the library refuses the origin as an issuer. */
export function authorizationServerFor(
  origin: string
): OAuthAuthorizationServer<Env> | null {
  if (servers.has(origin)) {
    return servers.get(origin) ?? null;
  }
  let server: OAuthAuthorizationServer<Env> | null = null;
  try {
    server = new OAuthAuthorizationServer<Env>({
      issuer: origin,
      resources: [mcpResourceFor(origin)],
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
      clientRegistrationEndpoint: REGISTER_PATH,
      scopesSupported: [...OAUTH_SCOPES],
      clientIdMetadataDocumentEnabled: true,
      onError: ({ code, status, internal }) => {
        // The internal reason names the failed check; it never carries a secret.
        console.warn(
          JSON.stringify({
            oauth: "error",
            code,
            status,
            category: internal?.category,
            reason: internal?.reason,
          })
        );
      },
    });
  } catch (err) {
    // A non-loopback http origin: "must be a canonical absolute HTTPS URL".
    if (!(err instanceof TypeError)) {
      throw err;
    }
  }
  servers.set(origin, server);
  return server;
}

/**
 * The library's fetch handlers write `ctx.props` for protected handlers and otherwise ignore the
 * context. TanStack's server entry doesn't hand ours on, and nothing here needs `waitUntil`.
 */
export const libraryContext = () =>
  ({ props: undefined }) as unknown as ExecutionContext;

/**
 * Metadata, token, revocation and registration requests, and /mcp's RFC 9728 metadata; null for
 * every other path (src/server.ts hands those on), and where this origin can't do OAuth.
 */
export async function handleOAuthEndpoint(
  env: Env,
  request: Request
): Promise<Response | null> {
  const { origin, pathname } = new URL(request.url);
  const server = authorizationServerFor(origin);
  if (!server) {
    return null;
  }
  if (isAuthorizationServerPath(pathname)) {
    return await server.fetch(request, env, libraryContext());
  }
  if (isProtectedResourceMetadataPath(pathname)) {
    const { handleMcpRequest } = await import("./handler");
    return await handleMcpRequest(env, request);
  }
  return null;
}
