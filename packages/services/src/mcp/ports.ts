import type { ApiKeyRow, McpCallRow, OauthConnectionRow } from "@repo/db";
import type { CallInsert } from "@repo/db/api-keys";

/**
 * Storage ports of the MCP services. `@repo/db` backs them (`createApiKeyTable`,
 * `createMcpCallLog`, `createOauthConnectionTable`; `ports.typecheck.ts` checks the fit) and
 * hands back raw rows with `Date`s. Key generation, hashing, name rules and `toInfo` shaping are
 * the services' job.
 */

export type ApiKeyStore = {
  insert: (row: ApiKeyRow) => Promise<void>;
  /** Every key, newest first (revoked ones included). */
  list: () => Promise<ApiKeyRow[]>;
  findByHash: (keyHash: string) => Promise<ApiKeyRow | null>;
  /** False when there's no such key or it was revoked already. */
  revoke: (id: string, at: Date) => Promise<boolean>;
  touchLastUsed: (id: string, at: Date) => Promise<void>;
};

export type McpCallLog = {
  record: (call: CallInsert) => Promise<void>;
  /** The latest calls of a key (or, with `kind: "oauth"`, of a connection), newest first. */
  recent: (
    id: string,
    limit: number,
    kind?: "api-key" | "oauth"
  ) => Promise<McpCallRow[]>;
  /** Deletes calls before `before`; returns how many went. */
  prune: (before: Date) => Promise<number>;
};

export type OauthConnectionStore = {
  /** `sameRedirectUriOnly` is true for a CIMD client; earlier grants of the same client are marked revoked. */
  create: (
    row: OauthConnectionRow,
    opts: { sameRedirectUriOnly: boolean }
  ) => Promise<void>;
  list: () => Promise<OauthConnectionRow[]>;
  get: (id: string) => Promise<OauthConnectionRow | null>;
  touch: (
    id: string,
    patch: { grantId?: string; lastUsedAt?: Date }
  ) => Promise<void>;
  /** False when there's no such active connection. */
  markRevoked: (id: string, at: Date) => Promise<boolean>;
};

/**
 * The grants of the OAuth provider library (stored in the OAuth KV namespace), as far as revoking
 * a connection needs them. The web app adapts `server.getOAuthApi(env)` to it.
 */
export type OAuthGrants = {
  listUserGrants: (
    userId: string,
    opts?: { cursor?: string }
  ) => Promise<{
    items: { id: string; metadata?: unknown }[];
    cursor?: string;
  }>;
  revokeGrant: (grantId: string, userId: string) => Promise<unknown>;
};
