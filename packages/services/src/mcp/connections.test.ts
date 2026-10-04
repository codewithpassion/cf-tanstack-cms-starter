// biome-ignore-all lint/style/noNonNullAssertion: test-only; rows are checked just above.
import { describe, expect, it } from "bun:test";
import { oauthConnections } from "@repo/db";
import { createOauthConnectionTable } from "@repo/db/oauth-connections";
import { createTestDb } from "@repo/db/test-utils";

import {
  type ConnectionDeps,
  clientLabel,
  connectionName,
  createConnection,
  listConnections,
  revokeConnection,
  verifyConnection,
} from "./connections";
import type { OAuthGrants } from "./ports";
import {
  claudeMcpAddCommand,
  fromOAuthScopes,
  mcpServerName,
  OAUTH_SCOPES,
  toOAuthScope,
} from "./scopes";

const T0 = Date.UTC(2026, 9, 3, 2);
const CB = "http://localhost:33418/callback";

function setup() {
  const { db } = createTestDb();
  const d: ConnectionDeps = {
    connections: createOauthConnectionTable(db),
    clock: () => new Date(T0),
  };
  return { db, d };
}

const connect = (
  d: ConnectionDeps,
  over: Partial<Parameters<typeof createConnection>[1]> = {}
) =>
  createConnection(d, {
    id: "conn1",
    userId: "user_admin",
    email: "admin@example.com",
    clientId: "dcr-client",
    clientName: "Test MCP client",
    redirectUri: CB,
    scope: "read",
    now: T0,
    ...over,
  });

describe("OAuth scopes", () => {
  it("map cms:read/write/full to the API key scopes, broadest first", () => {
    expect(OAUTH_SCOPES).toEqual(["cms:read", "cms:write", "cms:full"]);
    expect(toOAuthScope("write")).toBe("cms:write");
    expect(fromOAuthScopes(["cms:read"])).toBe("read");
    expect(fromOAuthScopes(["cms:read", "cms:full"])).toBe("full");
    expect(fromOAuthScopes(["offline_access", "cms:write"])).toBe("write");
    expect(fromOAuthScopes(["mcp:read", "full"])).toBeNull();
    expect(fromOAuthScopes([])).toBeNull();
  });

  it("names the MCP server after the site, cms when nothing is left", () => {
    expect(mcpServerName("My Site!")).toBe("my-site");
    expect(mcpServerName("***")).toBe("cms");
    expect(
      claudeMcpAddCommand("my-site", "https://example.com", "cms_dev_x")
    ).toBe(
      'claude mcp add --transport http my-site https://example.com/mcp --header "Authorization: Bearer cms_dev_x"'
    );
  });
});

describe("connection names", () => {
  it("name a connection after the client and the day, without #", () => {
    expect(connectionName("Claude", "x", T0)).toBe("Claude (3 Oct 2026)");
    expect(connectionName("  ", "client123", T0)).toBe(
      "client123 (3 Oct 2026)"
    );
    // `#` separates an MCP author's name from a key prefix.
    expect(clientLabel("Evil#cms_live_x", "c")).toBe("Evilcms_live_x");
  });
});

describe("connections (SQL)", () => {
  it("records an approved grant and lists it", async () => {
    const { d } = setup();
    const info = await connect(d);
    expect(info).toMatchObject({
      id: "conn1",
      clientName: "Test MCP client",
      scope: "read",
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(await listConnections(d)).toEqual([info]);
  });

  it("a new grant revokes the user's earlier one for the same client", async () => {
    const { d } = setup();
    await connect(d, { id: "a" });
    await connect(d, { id: "b", now: T0 + 1000 });
    const rows = await listConnections(d);
    expect(rows.map((r) => [r.id, r.revokedAt !== null])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("a CIMD client only replaces the grant from the same redirect URI", async () => {
    const { d } = setup();
    const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    await connect(d, {
      id: "web",
      clientId,
      redirectUri: "https://claude.ai/cb",
    });
    await connect(d, { id: "cli", clientId, redirectUri: CB, now: T0 + 1000 });
    expect((await listConnections(d)).every((r) => r.revokedAt === null)).toBe(
      true
    );
  });

  it("verifies a token: fills in grant_id, records use at most once a minute, refuses revoked or foreign users", async () => {
    const { db, d } = setup();
    await connect(d);
    const token = {
      connectionId: "conn1",
      userId: "user_admin",
      grantId: "g1",
      scope: "read" as const,
    };
    expect(await verifyConnection(d, token, T0)).toMatchObject({
      id: "conn1",
      scope: "read",
      kind: "oauth",
    });
    const [row] = await db.select().from(oauthConnections);
    expect(row!.grantId).toBe("g1");
    expect(row!.lastUsedAt?.getTime()).toBe(T0);
    await verifyConnection(d, token, T0 + 1000);
    expect(
      (await db.select().from(oauthConnections))[0]!.lastUsedAt?.getTime()
    ).toBe(T0);
    await verifyConnection(d, token, T0 + 60_000);
    expect(
      (await db.select().from(oauthConnections))[0]!.lastUsedAt?.getTime()
    ).toBe(T0 + 60_000);
    expect(
      await verifyConnection(d, { ...token, userId: "other" }, T0)
    ).toBeNull();
    expect(
      await verifyConnection(d, { ...token, connectionId: "nope" }, T0)
    ).toBeNull();
    await db.update(oauthConnections).set({ revokedAt: new Date(T0) });
    expect(await verifyConnection(d, token, T0)).toBeNull();
  });

  it("revoke: marks the row, then revokes every grant tied to the connection (by metadata, too)", async () => {
    const { d } = setup();
    await connect(d);
    await d.connections.touch("conn1", { grantId: "g1" });
    const revoked: string[] = [];
    const grants: OAuthGrants = {
      listUserGrants: (_user, opts) =>
        Promise.resolve(
          opts?.cursor
            ? { items: [{ id: "g2", metadata: { connectionId: "conn1" } }] }
            : {
                items: [{ id: "other", metadata: { connectionId: "x" } }],
                cursor: "next",
              }
        ),
      revokeGrant: (id) => {
        revoked.push(id);
        return Promise.resolve();
      },
    };
    expect(await revokeConnection(d, grants, "conn1", T0)).toBe(true);
    expect(revoked.sort()).toEqual(["g1", "g2"]);
    expect((await listConnections(d))[0]!.revokedAt).not.toBeNull();
    expect(await revokeConnection(d, grants, "conn1", T0)).toBe(false);
    expect(await revokeConnection(d, grants, "nope", T0)).toBe(false);
  });

  it("revoke without a grant API still marks the row", async () => {
    const { d } = setup();
    await connect(d);
    expect(await revokeConnection(d, null, "conn1", T0)).toBe(true);
  });
});
