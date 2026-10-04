// biome-ignore-all lint/style/noExportedImports: re-exports the shared retention and last-used constants from `@repo/db/shared`.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; one regex per request.

import type { ApiKeyRow } from "@repo/db";
import {
  type ApiScope,
  CALL_RETENTION_DAYS,
  LAST_USED_EVERY_MS,
} from "@repo/db/shared";
import { nanoid } from "nanoid";
import { type Clock, systemClock } from "../clock";
import { sha256Hex } from "../cms/media-bytes";
import type { ApiKeyStore, McpCallLog } from "./ports";

/**
 * API keys and the call log for the MCP server (docs/2026-10-03-mcp-server-prd.md §4.1, §4.4).
 * A key is `cms_<env>_<32 base62>`: `live` when it was created on the production site, `dev` in
 * local dev (each has its own D1, so a key only works where it was made).
 * Only its SHA-256 is stored; a request's key is checked by looking the hash up.
 */

export type KeyDeps = {
  keys: ApiKeyStore;
  calls: McpCallLog;
  clock?: Clock;
};

const nowOf = (d: KeyDeps) => (d.clock ?? systemClock)().getTime();

export type KeyEnv = "live" | "dev";

export type ApiKeyInfo = {
  id: string;
  name: string;
  prefix: string;
  scope: ApiScope;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** The key a request carries, once checked: what the tools need to know about it. */
export type AuthedKey = {
  id: string;
  name: string;
  /** `cms_<env>_` and the first characters, as /admin/api-keys shows it; in the revision author. */
  prefix: string;
  scope: ApiScope;
};

/**
 * Who is calling `/mcp`: an API key, or an OAuth connection (./connections.ts), whose `id` is the
 * connection id and whose `name` is `<client name> (<date>)`. The tools treat both alike.
 */
export type McpIdentity =
  | (AuthedKey & { kind: "api-key" })
  | { kind: "oauth"; id: string; name: string; scope: ApiScope };

export const KEY_RANDOM_LENGTH = 32;
/** Characters after `cms_<env>_` shown in the admin list. */
export const PREFIX_LENGTH = 8;
const MAX_NAME = 60;

export { CALL_RETENTION_DAYS, LAST_USED_EVERY_MS };

const KEY_FORMAT = /^cms_(live|dev)_[A-Za-z0-9]{32}$/;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyError";
  }
}

/**
 * `live` for keys made on the production site (`siteOrigin`, from the site config), `dev`
 * everywhere else (local dev). An empty `siteOrigin` (not configured) is never live.
 */
export function keyEnvFor(origin: string, siteOrigin: string): KeyEnv {
  return siteOrigin !== "" && origin === siteOrigin ? "live" : "dev";
}

/** 32 base62 characters from the CSPRNG, by rejection sampling (bytes ≥ 248 are drawn again, so every character is equally likely). */
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && out.length < length) {
        out += BASE62[b % 62];
      }
    }
  }
  return out;
}

export function generateApiKey(env: KeyEnv): { key: string; prefix: string } {
  const random = randomBase62(KEY_RANDOM_LENGTH);
  return {
    key: `cms_${env}_${random}`,
    prefix: `cms_${env}_${random.slice(0, PREFIX_LENGTH)}`,
  };
}

export function hashApiKey(key: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(key));
}

/** The bearer token of `Authorization: Bearer <key>`, or null. */
export function bearerKey(request: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(
    request.headers.get("Authorization") ?? ""
  );
  return m?.[1] ?? null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toInfo(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  };
}

/** Creates a key. The raw key is returned this once and never stored. */
export async function createApiKey(
  d: KeyDeps,
  input: {
    name: string;
    scope: ApiScope;
    createdBy: string | null;
    env: KeyEnv;
    now?: number;
  }
): Promise<{ key: string; info: ApiKeyInfo }> {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME) {
    throw new ApiKeyError(
      `Give the key a name of 1 to ${MAX_NAME} characters.`
    );
  }
  const { key, prefix } = generateApiKey(input.env);
  const row: ApiKeyRow = {
    id: nanoid(),
    name,
    prefix,
    keyHash: await hashApiKey(key),
    scope: input.scope,
    createdBy: input.createdBy,
    createdAt: new Date(input.now ?? nowOf(d)),
    lastUsedAt: null,
    revokedAt: null,
  };
  await d.keys.insert(row);
  return { key, info: toInfo(row) };
}

/** Every key, newest first (revoked ones included). */
export async function listApiKeys(d: KeyDeps): Promise<ApiKeyInfo[]> {
  return (await d.keys.list()).map(toInfo);
}

/** Revokes a key at once. False when there's no such key or it was revoked already. */
export function revokeApiKey(
  d: KeyDeps,
  id: string,
  now = nowOf(d)
): Promise<boolean> {
  return d.keys.revoke(id, new Date(now));
}

/**
 * The key `raw` belongs to, or null for a malformed, unknown or revoked key. Records the use
 * (`last_used_at`) when the last one is over a minute old.
 */
export async function verifyApiKey(
  d: KeyDeps,
  raw: string | null,
  now = nowOf(d)
): Promise<AuthedKey | null> {
  if (!(raw && KEY_FORMAT.test(raw))) {
    return null;
  }
  const row = await d.keys.findByHash(await hashApiKey(raw));
  if (!row || row.revokedAt) {
    return null;
  }
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
    await d.keys.touchLastUsed(row.id, new Date(now));
  }
  return { id: row.id, name: row.name, prefix: row.prefix, scope: row.scope };
}

// ---------------------------------------------------------------------------------------------
// Call log

export type McpCall = {
  id: number;
  tool: string;
  target: string | null;
  ok: boolean;
  errorCode: string | null;
  at: string;
};

/** Exactly one of `keyId` and `connectionId`. */
export type CallPrincipal =
  | { keyId: string; connectionId?: null }
  | { keyId?: null; connectionId: string };

export const principalOf = (who: McpIdentity): CallPrincipal =>
  who.kind === "oauth" ? { connectionId: who.id } : { keyId: who.id };

export async function recordCall(
  d: KeyDeps,
  call: CallPrincipal & {
    tool: string;
    target: string | null;
    ok: boolean;
    errorCode: string | null;
    at?: number;
  }
): Promise<void> {
  await d.calls.record({
    keyId: call.keyId ?? null,
    connectionId: call.connectionId ?? null,
    tool: call.tool.slice(0, 64),
    target: call.target?.slice(0, 200) ?? null,
    ok: call.ok,
    errorCode: call.errorCode?.slice(0, 40) ?? null,
    at: new Date(call.at ?? nowOf(d)),
  });
}

/** The latest calls of a key (or, with `kind: "oauth"`, of a connection), newest first. */
export async function recentCalls(
  d: KeyDeps,
  id: string,
  limit = 50,
  kind: McpIdentity["kind"] = "api-key"
): Promise<McpCall[]> {
  const rows = await d.calls.recent(id, limit, kind);
  return rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    target: r.target,
    ok: r.ok,
    errorCode: r.errorCode,
    at: r.at.toISOString(),
  }));
}

/** Deletes calls older than 90 days (the daily cron). Returns how many went. */
export function pruneCalls(d: KeyDeps, now = nowOf(d)): Promise<number> {
  return d.calls.prune(new Date(now - CALL_RETENTION_DAYS * 86_400_000));
}

/** The key service with its ports bound. */
export const createApiKeysService = (d: KeyDeps) => ({
  create: (input: Parameters<typeof createApiKey>[1]) => createApiKey(d, input),
  list: () => listApiKeys(d),
  revoke: (id: string, now?: number) => revokeApiKey(d, id, now),
  verify: (raw: string | null, now?: number) => verifyApiKey(d, raw, now),
  recordCall: (call: Parameters<typeof recordCall>[1]) => recordCall(d, call),
  recentCalls: (id: string, limit?: number, kind?: McpIdentity["kind"]) =>
    recentCalls(d, id, limit, kind),
  pruneCalls: (now?: number) => pruneCalls(d, now),
});
