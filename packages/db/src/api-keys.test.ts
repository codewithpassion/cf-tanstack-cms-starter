import { describe, expect, it } from "bun:test";

import { createApiKeyTable, createMcpCallLog } from "./api-keys.ts";
import { createOauthConnectionTable } from "./oauth-connections.ts";
import type { ApiKeyRow, OauthConnectionRow } from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

const T0 = Date.UTC(2026, 9, 3);
const key = (id: string, over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id,
  name: `Key ${id}`,
  prefix: `cms_dev_${id}`,
  keyHash: `hash-${id}`,
  scope: "read",
  createdBy: "user_1",
  createdAt: new Date(T0),
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

describe("api key table", () => {
  it("finds a key by its hash and lists newest first, revoked included", async () => {
    const { db } = createTestDb();
    const keys = createApiKeyTable(db);
    await keys.insert(key("a", { createdAt: new Date(T0) }));
    await keys.insert(key("b", { createdAt: new Date(T0 + 1000) }));
    expect((await keys.findByHash("hash-a"))?.id).toBe("a");
    expect(await keys.findByHash("nope")).toBeNull();
    expect(await keys.revoke("a", new Date(T0 + 5))).toBe(true);
    expect((await keys.list()).map((k) => k.id)).toEqual(["b", "a"]);
  });

  it("enforces unique hashes", async () => {
    const { db } = createTestDb();
    const keys = createApiKeyTable(db);
    await keys.insert(key("a"));
    await expect(
      keys.insert(key("b", { keyHash: "hash-a" }))
    ).rejects.toThrow();
  });

  it("revokes once: false for an unknown or already revoked key", async () => {
    const { db } = createTestDb();
    const keys = createApiKeyTable(db);
    await keys.insert(key("a"));
    expect(await keys.revoke("a", new Date(T0 + 1))).toBe(true);
    expect(await keys.revoke("a", new Date(T0 + 2))).toBe(false);
    expect(await keys.revoke("zz", new Date(T0))).toBe(false);
    expect((await keys.findByHash("hash-a"))?.revokedAt?.getTime()).toBe(
      T0 + 1
    );
  });

  it("records the last use", async () => {
    const { db } = createTestDb();
    const keys = createApiKeyTable(db);
    await keys.insert(key("a"));
    await keys.touchLastUsed("a", new Date(T0 + 9));
    expect((await keys.findByHash("hash-a"))?.lastUsedAt?.getTime()).toBe(
      T0 + 9
    );
  });
});

describe("mcp call log", () => {
  it("logs per key or connection, newest first, and prunes old rows", async () => {
    const { db } = createTestDb();
    const keys = createApiKeyTable(db);
    const conns = createOauthConnectionTable(db);
    const log = createMcpCallLog(db);
    await keys.insert(key("k1"));
    const conn: OauthConnectionRow = {
      id: "c1",
      grantId: null,
      userId: "user_1",
      email: "a@example.com",
      clientId: "client",
      clientName: "Client",
      redirectUri: "https://example.com/cb",
      name: "Client (3 Oct 2026)",
      scope: "write",
      createdAt: new Date(T0),
      lastUsedAt: null,
      revokedAt: null,
    };
    await conns.create(conn, { sameRedirectUriOnly: false });
    const call = (over: object) => ({
      at: new Date(T0),
      connectionId: null,
      errorCode: null,
      keyId: null,
      ok: true,
      target: null,
      tool: "list_pages",
      ...over,
    });
    await log.record(call({ keyId: "k1", at: new Date(T0) }));
    await log.record(
      call({
        keyId: "k1",
        at: new Date(T0 + 1000),
        tool: "get_page",
        ok: false,
        errorCode: "NOT_FOUND",
      })
    );
    await log.record(call({ connectionId: "c1", at: new Date(T0 + 2000) }));
    expect((await log.recent("k1", 10)).map((c) => c.tool)).toEqual([
      "get_page",
      "list_pages",
    ]);
    expect((await log.recent("k1", 1)).length).toBe(1);
    expect((await log.recent("c1", 10, "oauth")).length).toBe(1);
    expect(await log.prune(new Date(T0 + 500))).toBe(1);
    expect((await log.recent("k1", 10)).length).toBe(1);
  });
});
