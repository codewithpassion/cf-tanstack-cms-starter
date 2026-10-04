import { describe, expect, it } from "bun:test";

import { createOauthConnectionTable } from "./oauth-connections.ts";
import type { OauthConnectionRow } from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

const T0 = Date.UTC(2026, 9, 3);
const conn = (
  id: string,
  over: Partial<OauthConnectionRow> = {}
): OauthConnectionRow => ({
  id,
  grantId: null,
  userId: "user_1",
  email: "a@example.com",
  clientId: "https://client.example/meta.json",
  clientName: "Client",
  redirectUri: "https://client.example/cb1",
  name: "Client (3 Oct 2026)",
  scope: "write",
  createdAt: new Date(T0),
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

const revoked = async (t: ReturnType<typeof createOauthConnectionTable>) =>
  Object.fromEntries((await t.list()).map((c) => [c.id, c.revokedAt !== null]));

describe("oauth connection table", () => {
  it("a new approval revokes the user's earlier connection for the same client", async () => {
    const { db } = createTestDb();
    const t = createOauthConnectionTable(db);
    await t.create(conn("c1", { clientId: "reg-1" }), {
      sameRedirectUriOnly: false,
    });
    await t.create(
      conn("c2", { clientId: "reg-1", createdAt: new Date(T0 + 1) }),
      { sameRedirectUriOnly: false }
    );
    // Another user's connection for the same client is left alone.
    await t.create(
      conn("c3", {
        clientId: "reg-1",
        userId: "user_2",
        createdAt: new Date(T0 + 2),
      }),
      { sameRedirectUriOnly: false }
    );
    expect(await revoked(t)).toEqual({ c1: true, c2: false, c3: false });
  });

  it("for a CIMD client, only the connection from the same redirect URI is replaced", async () => {
    const { db } = createTestDb();
    const t = createOauthConnectionTable(db);
    await t.create(conn("c1"), { sameRedirectUriOnly: true });
    await t.create(
      conn("c2", {
        redirectUri: "https://client.example/cb2",
        createdAt: new Date(T0 + 1),
      }),
      { sameRedirectUriOnly: true }
    );
    await t.create(conn("c3", { createdAt: new Date(T0 + 2) }), {
      sameRedirectUriOnly: true,
    });
    expect(await revoked(t)).toEqual({ c1: true, c2: false, c3: false });
    expect((await t.list()).map((c) => c.id)).toEqual(["c3", "c2", "c1"]);
  });

  it("touches grant id and last use, and revokes an active connection once", async () => {
    const { db } = createTestDb();
    const t = createOauthConnectionTable(db);
    await t.create(conn("c1"), { sameRedirectUriOnly: true });
    await t.touch("c1", {});
    await t.touch("c1", { grantId: "g1", lastUsedAt: new Date(T0 + 7) });
    expect(await t.get("c1")).toMatchObject({ grantId: "g1" });
    expect((await t.get("c1"))?.lastUsedAt?.getTime()).toBe(T0 + 7);
    expect(await t.markRevoked("c1", new Date(T0 + 8))).toBe(true);
    expect(await t.markRevoked("c1", new Date(T0 + 9))).toBe(false);
    expect(await t.markRevoked("zz", new Date(T0))).toBe(false);
    expect(await t.get("zz")).toBeNull();
  });
});
