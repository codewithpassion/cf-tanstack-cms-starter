// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";
import { apiKeys, mcpCalls } from "@repo/db";
import { createApiKeyTable, createMcpCallLog } from "@repo/db/api-keys";
import { createTestDb } from "@repo/db/test-utils";
import {
  bearerKey,
  createApiKey,
  generateApiKey,
  hashApiKey,
  type KeyDeps,
  keyEnvFor,
  LAST_USED_EVERY_MS,
  listApiKeys,
  pruneCalls,
  recentCalls,
  recordCall,
  revokeApiKey,
  verifyApiKey,
} from "./keys";
import { scopeAllows } from "./scopes";

const T0 = Date.UTC(2026, 9, 3);

/** Real tables over the migrated bun:sqlite stand-in for D1. */
function setup() {
  const { db, log } = createTestDb();
  const d: KeyDeps = {
    keys: createApiKeyTable(db),
    calls: createMcpCallLog(db),
  };
  return { db, log, d };
}

describe("API key format", () => {
  it("is cms_<env>_<32 base62>, with the first 8 random characters in the prefix", () => {
    const { key, prefix } = generateApiKey("live");
    expect(key).toMatch(/^cms_live_[A-Za-z0-9]{32}$/);
    expect(prefix).toBe(key.slice(0, "cms_live_".length + 8));
    expect(generateApiKey("dev").key).toMatch(/^cms_dev_[A-Za-z0-9]{32}$/);
    expect(generateApiKey("live").key).not.toBe(key);
  });

  it("is live only on the production origin", () => {
    expect(keyEnvFor("https://example.com", "https://example.com")).toBe(
      "live"
    );
    expect(
      keyEnvFor("https://staging.example.com", "https://example.com")
    ).toBe("dev");
    expect(keyEnvFor("http://localhost:5173", "https://example.com")).toBe(
      "dev"
    );
  });

  it("hashes to SHA-256 hex", async () => {
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("reads the bearer token", () => {
    const req = (h?: string) =>
      new Request("https://x/mcp", { headers: h ? { Authorization: h } : {} });
    expect(bearerKey(req("Bearer cms_dev_abc"))).toBe("cms_dev_abc");
    expect(bearerKey(req("bearer  cms_dev_abc "))).toBe("cms_dev_abc");
    expect(bearerKey(req("Basic xyz"))).toBeNull();
    expect(bearerKey(req())).toBeNull();
  });
});

describe("scopes", () => {
  it("each scope includes the ones below it", () => {
    expect(scopeAllows("read", "read")).toBe(true);
    expect(scopeAllows("read", "write")).toBe(false);
    expect(scopeAllows("write", "read")).toBe(true);
    expect(scopeAllows("write", "full")).toBe(false);
    expect(scopeAllows("full", "write")).toBe(true);
    expect(scopeAllows("full", "full")).toBe(true);
  });
});

describe("API keys in D1 (SQL)", () => {
  it("stores only the hash, and finds the key by it", async () => {
    const { db, d } = setup();
    const { key, info } = await createApiKey(d, {
      name: " laptop ",
      scope: "write",
      createdBy: "user_1",
      env: "dev",
      now: T0,
    });
    expect(info).toMatchObject({
      name: "laptop",
      scope: "write",
      prefix: key.slice(0, "cms_dev_".length + 8),
      createdBy: "user_1",
      lastUsedAt: null,
      revokedAt: null,
    });
    const [row] = await db.select().from(apiKeys);
    expect(row!.keyHash).toBe(await hashApiKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(await verifyApiKey(d, key, T0)).toEqual({
      id: info.id,
      name: "laptop",
      prefix: info.prefix,
      scope: "write",
    });
  });

  it("rejects unknown, malformed and missing keys", async () => {
    const { d } = setup();
    await createApiKey(d, {
      name: "a",
      scope: "read",
      createdBy: null,
      env: "dev",
    });
    expect(await verifyApiKey(d, generateApiKey("dev").key)).toBeNull();
    expect(await verifyApiKey(d, "cms_dev_short")).toBeNull();
    expect(await verifyApiKey(d, null)).toBeNull();
  });

  it("refuses an empty or long name", async () => {
    const { d } = setup();
    await expect(
      createApiKey(d, {
        name: "  ",
        scope: "read",
        createdBy: null,
        env: "dev",
      })
    ).rejects.toThrow(/name/);
    await expect(
      createApiKey(d, {
        name: "x".repeat(61),
        scope: "read",
        createdBy: null,
        env: "dev",
      })
    ).rejects.toThrow(/name/);
  });

  it("a revoked key stops working at once", async () => {
    const { d } = setup();
    const { key, info } = await createApiKey(d, {
      name: "a",
      scope: "full",
      createdBy: null,
      env: "dev",
      now: T0,
    });
    expect(await verifyApiKey(d, key, T0)).not.toBeNull();
    expect(await revokeApiKey(d, info.id, T0 + 1)).toBe(true);
    expect(await verifyApiKey(d, key, T0 + 2)).toBeNull();
    expect(await revokeApiKey(d, info.id)).toBe(false);
    expect(await revokeApiKey(d, "nope")).toBe(false);
    const [listed] = await listApiKeys(d);
    expect(listed!.revokedAt).toBe(new Date(T0 + 1).toISOString());
  });

  it("updates last_used_at at most once a minute", async () => {
    const { log, d } = setup();
    const { key } = await createApiKey(d, {
      name: "a",
      scope: "read",
      createdBy: null,
      env: "dev",
      now: T0,
    });
    const updates = () =>
      log.filter((l) => l.sql.startsWith('update "api_keys"')).length;
    await verifyApiKey(d, key, T0);
    await verifyApiKey(d, key, T0 + 1000);
    await verifyApiKey(d, key, T0 + LAST_USED_EVERY_MS - 1);
    expect(updates()).toBe(1);
    await verifyApiKey(d, key, T0 + LAST_USED_EVERY_MS);
    expect(updates()).toBe(2);
    const [listed] = await listApiKeys(d);
    expect(listed!.lastUsedAt).toBe(
      new Date(T0 + LAST_USED_EVERY_MS).toISOString()
    );
  });
});

describe("call log (SQL)", () => {
  it("lists a key's latest calls first and prunes those older than 90 days", async () => {
    const { db, d } = setup();
    const a = (
      await createApiKey(d, {
        name: "a",
        scope: "read",
        createdBy: null,
        env: "dev",
      })
    ).info;
    const b = (
      await createApiKey(d, {
        name: "b",
        scope: "read",
        createdBy: null,
        env: "dev",
      })
    ).info;
    const day = 86_400_000;
    await recordCall(d, {
      keyId: a.id,
      tool: "get_page",
      target: "about",
      ok: true,
      errorCode: null,
      at: T0 - 91 * day,
    });
    await recordCall(d, {
      keyId: a.id,
      tool: "update_page",
      target: "about",
      ok: false,
      errorCode: "STALE_DRAFT",
      at: T0 - day,
    });
    await recordCall(d, {
      keyId: b.id,
      tool: "list_pages",
      target: null,
      ok: true,
      errorCode: null,
      at: T0,
    });
    expect((await recentCalls(d, a.id)).map((c) => c.tool)).toEqual([
      "update_page",
      "get_page",
    ]);
    expect((await recentCalls(d, a.id))[0]).toMatchObject({
      ok: false,
      errorCode: "STALE_DRAFT",
      target: "about",
    });
    expect(await pruneCalls(d, T0)).toBe(1);
    expect(await db.select().from(mcpCalls)).toHaveLength(2);
  });
});
