// biome-ignore-all lint/style/noExportedImports: re-exports the db row and patch types next to the port that uses them, so services import one path.
/**
 * API key scopes for the MCP server (docs/2026-10-03-mcp-server-prd.md §4.1). Each scope includes
 * the ones before it: `read` the read tools, `write` also drafts, proposals, media and
 * accept/reject, `full` also publish, unpublish, archive and rollback. Shared by the server and
 * /admin/api-keys, so it imports only `@repo/db/shared` (browser-safe).
 */

import { API_SCOPES, type ApiScope } from "@repo/db/shared";

export { API_SCOPES, type ApiScope };

export const SCOPE_HELP: Record<ApiScope, string> = {
  read: "Read pages, SEO, revisions, the review queue and the site settings.",
  write:
    "Also edit drafts, create pages, propose, accept and reject changes, upload media and edit the site draft.",
  full: "Also publish, unpublish, archive, unarchive and roll back live pages and the site.",
};

export const isApiScope = (v: unknown): v is ApiScope =>
  API_SCOPES.includes(v as ApiScope);

/** Whether a key with scope `have` may call a tool that needs `need`. */
export function scopeAllows(have: ApiScope, need: ApiScope): boolean {
  return API_SCOPES.indexOf(have) >= API_SCOPES.indexOf(need);
}

/** The MCP server name: the site name as a slug (`My Site` becomes `my-site`), `cms` when nothing is left (D12). */
export function mcpServerName(siteName: string): string {
  const slug = siteName
    .toLowerCase()
    .replace(NON_SLUG, "-")
    .replace(EDGE_DASHES, "");
  return slug || "cms";
}

const NON_SLUG = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/** The `claude mcp add` command for a key, as /admin/api-keys shows it. */
export function claudeMcpAddCommand(
  serverName: string,
  origin: string,
  key: string
): string {
  return `claude mcp add --transport http ${serverName} ${origin}/mcp --header "Authorization: Bearer ${key}"`;
}

/**
 * OAuth scopes for clients that sign in (docs/2026-10-03-mcp-oauth-prd.md): `cms:read`,
 * `cms:write` and `cms:full` are the same three scopes as API keys.
 */
export const OAUTH_SCOPES = API_SCOPES.map((s) => `cms:${s}` as const);
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const toOAuthScope = (scope: ApiScope): OAuthScope => `cms:${scope}`;

/** The broadest API scope among a token's OAuth scopes, or null when it carries none of ours. */
export function fromOAuthScopes(scopes: readonly string[]): ApiScope | null {
  return (
    [...API_SCOPES].reverse().find((s) => scopes.includes(`cms:${s}`)) ?? null
  );
}
