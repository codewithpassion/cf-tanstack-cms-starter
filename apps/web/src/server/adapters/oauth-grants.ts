import type { OAuthGrants } from "@repo/services/mcp/ports";
import { authorizationServerFor } from "#/server/mcp/oauth";

/**
 * The OAuth provider library's grants (OAUTH_KV), as the connections service's `OAuthGrants`
 * port. Null where the library refuses `origin` as an issuer: no server there, so no grant to revoke.
 */
export function oauthGrantsFor(env: Env, origin: string): OAuthGrants | null {
  return authorizationServerFor(origin)?.getOAuthApi(env) ?? null;
}
