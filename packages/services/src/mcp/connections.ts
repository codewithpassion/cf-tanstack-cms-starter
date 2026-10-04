import type { ApiScope } from "@repo/cms-core/mcp/scopes";
import type { OauthConnectionRow } from "@repo/db";
import { LAST_USED_EVERY_MS } from "@repo/db/shared";

import { type Clock, systemClock } from "../clock";
import type { McpIdentity } from "./keys";
import type { OAuthGrants, OauthConnectionStore } from "./ports";

/**
 * OAuth connections to the MCP server (docs/2026-10-03-mcp-oauth-prd.md): one D1 row per grant an
 * admin approved on /oauth/authorize. The grant itself (tokens, encrypted props) lives in the
 * OAuth KV namespace, behind the provider library (`OAuthGrants`); this row is what /admin/api-keys
 * lists and revokes, and what `/mcp` checks on every OAuth request, so a revoke takes effect at once.
 */

export type ConnectionDeps = {
  connections: OauthConnectionStore;
  clock?: Clock;
};

const nowOf = (d: ConnectionDeps) => (d.clock ?? systemClock)().getTime();

export type ConnectionInfo = {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  email: string;
  scope: ApiScope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** What the library's grant carries in `props` (encrypted) and, as `connectionId`, in `metadata`. */
export type ConnectionProps = {
  userId: string;
  email: string;
  scope: ApiScope;
  connectionId: string;
  name: string;
};

const MAX_CLIENT_NAME = 60;
/** `#` separates the name from a key prefix in an MCP author (../author.ts); client names can't carry one. */
const HASHES = /#/g;

/**
 * The client's name as stored: without `#`, trimmed and capped, its client id when it gave none.
 * Client names are chosen by the client (a CIMD document or a registration), so never trusted.
 */
export const clientLabel = (clientName: string, clientId: string) =>
  clientName.replace(HASHES, "").trim().slice(0, MAX_CLIENT_NAME) ||
  clientId.replace(HASHES, "").slice(0, MAX_CLIENT_NAME);

// TODO(D14): the site's `timeZone` (SITE_TIME_ZONE) replaces this default once SiteConfig carries it.
const DEFAULT_TIME_ZONE = "UTC";

/** `<client name> (<date>)`, e.g. "Claude (3 Oct 2026)": the connection's `mcp:<name>` author. */
export function connectionName(
  clientName: string,
  clientId: string,
  now: number,
  timeZone = DEFAULT_TIME_ZONE
): string {
  const date = new Date(now).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  });
  return `${clientLabel(clientName, clientId)} (${date})`;
}

/** A CIMD client's id is its https metadata URL; a registered client's is an opaque string. */
const isCimdClient = (clientId: string) => clientId.startsWith("https://");

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toInfo(row: OauthConnectionRow): ConnectionInfo {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUri: row.redirectUri,
    email: row.email,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  };
}

/**
 * Records an approved grant, after the library stored it (a failed grant leaves no row). The
 * library revokes the user's earlier grant for the same client when it stores a new one (for a
 * CIMD client, only the one from the same redirect URI, since every installation shares the
 * client id), so the rows of those grants are marked revoked here too.
 */
export async function createConnection(
  d: ConnectionDeps,
  input: {
    id: string;
    userId: string;
    email: string;
    clientId: string;
    clientName: string;
    redirectUri: string;
    scope: ApiScope;
    now?: number;
    timeZone?: string;
  }
): Promise<ConnectionInfo> {
  const now = input.now ?? nowOf(d);
  const row: OauthConnectionRow = {
    id: input.id,
    grantId: null,
    userId: input.userId,
    email: input.email,
    clientId: input.clientId,
    clientName: clientLabel(input.clientName, input.clientId),
    redirectUri: input.redirectUri,
    name: connectionName(input.clientName, input.clientId, now, input.timeZone),
    scope: input.scope,
    createdAt: new Date(now),
    lastUsedAt: null,
    revokedAt: null,
  };
  await d.connections.create(row, {
    sameRedirectUriOnly: isCimdClient(input.clientId),
  });
  return toInfo(row);
}

/** Every connection, newest first (revoked ones included). */
export async function listConnections(
  d: ConnectionDeps
): Promise<ConnectionInfo[]> {
  return (await d.connections.list()).map(toInfo);
}

/**
 * The identity of a token the library already validated: null when its connection is unknown,
 * revoked, or belongs to another user. Fills in `grant_id` on first use and records the use
 * (`last_used_at`) when the last one is over a minute old. `scope` is the token's, not the row's.
 */
export async function verifyConnection(
  d: ConnectionDeps,
  token: {
    connectionId: string;
    userId: string;
    grantId: string | null;
    scope: ApiScope;
  },
  now = nowOf(d)
): Promise<McpIdentity | null> {
  const row = await d.connections.get(token.connectionId);
  if (!row || row.revokedAt || row.userId !== token.userId) {
    return null;
  }
  const patch: { grantId?: string; lastUsedAt?: Date } = {};
  if (!row.grantId && token.grantId) {
    patch.grantId = token.grantId;
  }
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
    patch.lastUsedAt = new Date(now);
  }
  await d.connections.touch(row.id, patch);
  return { id: row.id, name: row.name, scope: token.scope, kind: "oauth" };
}

/**
 * Revokes a connection: its D1 row first (`/mcp` checks it on every request), then its grant and
 * tokens in the OAuth KV, through `grants` (null when the provider can't issue for this origin, so
 * there is no grant to revoke). The grant is found by the connection id in its metadata, so a
 * connection that was never used (no `grant_id` yet) is revoked too. False when there's no active
 * connection.
 */
export async function revokeConnection(
  d: ConnectionDeps,
  grants: OAuthGrants | null,
  id: string,
  now = nowOf(d)
): Promise<boolean> {
  const row = await d.connections.get(id);
  if (!row || row.revokedAt) {
    return false;
  }
  if (!(await d.connections.markRevoked(id, new Date(now)))) {
    return false;
  }
  if (!grants) {
    return true;
  }
  const grantIds = new Set<string>(row.grantId ? [row.grantId] : []);
  let cursor: string | undefined;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each page's cursor comes from the one before.
    const page = await grants.listUserGrants(
      row.userId,
      cursor ? { cursor } : undefined
    );
    for (const grant of page.items) {
      if (
        (grant.metadata as { connectionId?: unknown } | null)?.connectionId ===
        id
      ) {
        grantIds.add(grant.id);
      }
    }
    ({ cursor } = page);
  } while (cursor);
  for (const grantId of grantIds) {
    // biome-ignore lint/performance/noAwaitInLoops: usually one grant; KV writes one at a time.
    await grants.revokeGrant(grantId, row.userId);
  }
  return true;
}

/** The connection service with its ports bound. */
export const createConnectionsService = (d: ConnectionDeps) => ({
  create: (input: Parameters<typeof createConnection>[1]) =>
    createConnection(d, input),
  list: () => listConnections(d),
  verify: (token: Parameters<typeof verifyConnection>[1], now?: number) =>
    verifyConnection(d, token, now),
  revoke: (grants: OAuthGrants | null, id: string, now?: number) =>
    revokeConnection(d, grants, id, now),
});
