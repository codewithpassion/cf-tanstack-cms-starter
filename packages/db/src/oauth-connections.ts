import { and, desc, eq, isNull, ne } from "drizzle-orm";

import {
  type D1Db,
  type OauthConnectionRow,
  oauthConnections,
} from "./schema.ts";

/**
 * One row per OAuth grant an admin approved on the authorize screen. The grant itself (tokens,
 * encrypted props) lives in the OAuth KV namespace; this row is what the admin lists and revokes,
 * and what the MCP endpoint checks on every OAuth request, so a revoke takes effect at once.
 * Row-level only: the client label, `<client> (<date>)` name and token checks belong to
 * `@repo/services`.
 */

export function createOauthConnectionTable(db: D1Db) {
  return {
    /**
     * Records an approved grant. The OAuth library revokes the user's earlier grant for the same
     * client when it stores a new one (for a CIMD client, only the one from the same redirect
     * URI, since every installation shares the client id), so the rows of those grants are marked
     * revoked here too: `sameRedirectUriOnly` is true for a CIMD client.
     */
    async create(
      row: OauthConnectionRow,
      { sameRedirectUriOnly }: { sameRedirectUriOnly: boolean }
    ): Promise<void> {
      await db
        .update(oauthConnections)
        .set({ revokedAt: row.createdAt })
        .where(
          and(
            eq(oauthConnections.userId, row.userId),
            eq(oauthConnections.clientId, row.clientId),
            isNull(oauthConnections.revokedAt),
            ne(oauthConnections.id, row.id),
            ...(sameRedirectUriOnly
              ? [eq(oauthConnections.redirectUri, row.redirectUri)]
              : [])
          )
        );
      await db.insert(oauthConnections).values(row);
    },

    /** Every connection, newest first (revoked ones included). */
    list(): Promise<OauthConnectionRow[]> {
      return db
        .select()
        .from(oauthConnections)
        .orderBy(desc(oauthConnections.createdAt));
    },

    async get(id: string): Promise<OauthConnectionRow | null> {
      const [row] = await db
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, id))
        .limit(1);
      return row ?? null;
    },

    /** Fills in `grant_id` and/or `last_used_at`; does nothing for an empty patch. */
    async touch(
      id: string,
      patch: { grantId?: string; lastUsedAt?: Date }
    ): Promise<void> {
      if (!(patch.grantId || patch.lastUsedAt)) {
        return;
      }
      await db
        .update(oauthConnections)
        .set(patch)
        .where(eq(oauthConnections.id, id));
    },

    /** Marks a connection revoked. False when there's no such active connection. */
    async markRevoked(id: string, at: Date): Promise<boolean> {
      const res = await db
        .update(oauthConnections)
        .set({ revokedAt: at })
        .where(
          and(eq(oauthConnections.id, id), isNull(oauthConnections.revokedAt))
        )
        .run();
      return res.meta.changes === 1;
    },
  };
}
