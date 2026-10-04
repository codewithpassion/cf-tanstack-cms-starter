import { and, desc, eq, isNull, lt } from "drizzle-orm";

import {
  type ApiKeyRow,
  apiKeys,
  type D1Db,
  type McpCallRow,
  mcpCalls,
} from "./schema.ts";

/**
 * Tables behind the CMS MCP server's API keys and its call log. Row-level only: the key format,
 * generation and hashing, the name rules and the `toInfo` shaping belong to `@repo/services`.
 * Only the SHA-256 of a key is stored (hex, unique); keys are revoked, never deleted, so the call
 * log keeps pointing at them.
 */

export function createApiKeyTable(db: D1Db) {
  return {
    async insert(row: ApiKeyRow): Promise<void> {
      await db.insert(apiKeys).values(row);
    },

    /** Every key, newest first (revoked ones included). */
    list(): Promise<ApiKeyRow[]> {
      return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
    },

    async findByHash(keyHash: string): Promise<ApiKeyRow | null> {
      const [row] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);
      return row ?? null;
    },

    /** Revokes a key at once. False when there's no such key or it was revoked already. */
    async revoke(id: string, at: Date): Promise<boolean> {
      const res = await db
        .update(apiKeys)
        .set({ revokedAt: at })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .run();
      return res.meta.changes === 1;
    },

    async touchLastUsed(id: string, at: Date): Promise<void> {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: at })
        .where(eq(apiKeys.id, id));
    },
  };
}

/** Exactly one of `keyId` and `connectionId`. */
export type CallPrincipal =
  | { keyId: string; connectionId?: null }
  | { keyId?: null; connectionId: string };

/** One MCP tool call to log. The caller truncates the free-text fields to their limits. */
export type CallInsert = {
  at: Date;
  connectionId: string | null;
  errorCode: string | null;
  keyId: string | null;
  ok: boolean;
  target: string | null;
  tool: string;
};

export function createMcpCallLog(db: D1Db) {
  return {
    async record(call: CallInsert): Promise<void> {
      await db.insert(mcpCalls).values(call);
    },

    /** The latest calls of a key (or, with `connection`, of an OAuth connection), newest first. */
    recent(
      id: string,
      limit: number,
      kind: "api-key" | "oauth" = "api-key"
    ): Promise<McpCallRow[]> {
      return db
        .select()
        .from(mcpCalls)
        .where(
          kind === "oauth"
            ? eq(mcpCalls.connectionId, id)
            : eq(mcpCalls.keyId, id)
        )
        .orderBy(desc(mcpCalls.at), desc(mcpCalls.id))
        .limit(limit);
    },

    /** Deletes calls before `before` (the daily cron). Returns how many went. */
    async prune(before: Date): Promise<number> {
      const res = await db
        .delete(mcpCalls)
        .where(lt(mcpCalls.at, before))
        .run();
      return res.meta.changes ?? 0;
    },
  };
}
