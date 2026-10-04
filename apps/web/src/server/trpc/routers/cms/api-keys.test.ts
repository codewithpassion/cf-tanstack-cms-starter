import { describe, expect, it } from "bun:test";
import { createApiKeyTable, createMcpCallLog } from "@repo/db/api-keys";
import { createOauthConnectionTable } from "@repo/db/oauth-connections";
import { createTestDb } from "@repo/db/test-utils";
import { createConnectionsService } from "@repo/services/mcp/connections";
import { createApiKeysService } from "@repo/services/mcp/keys";
import type { CmsServices } from "../../../cms/wiring.ts";
import type { Context } from "../../context.ts";
import { apiKeysRouter } from "./api-keys.ts";

const ADMIN = "ada@example.com";
const SITE = "https://example.com";
const KEY_RE = /^cms_(live|dev)_[A-Za-z0-9]{32}$/;

/** A caller over a real (in-memory SQLite) database; only what this router uses is wired. */
function setup(
  opts: {
    userId?: string | null;
    emails?: string[];
    requestOrigin?: string;
  } = {}
) {
  const {
    userId = "u1",
    emails = [ADMIN],
    requestOrigin = "http://localhost:3000",
  } = opts;
  const { db } = createTestDb();
  const apiKeys = createApiKeysService({
    keys: createApiKeyTable(db),
    calls: createMcpCallLog(db),
  });
  const cms = {
    apiKeys,
    connections: createConnectionsService({
      connections: createOauthConnectionTable(db),
    }),
    config: { name: "My Site", origin: SITE, gscProperty: null },
    requestOrigin,
    siteOriginVar: SITE,
  } as unknown as CmsServices;
  const ctx: Context = {
    adminEmails: [ADMIN],
    auth: { userId, verifiedEmails: () => Promise.resolve(emails) },
    services: { cms },
    userId,
  };
  return { caller: apiKeysRouter.createCaller(ctx), apiKeys };
}

describe("admin gate", () => {
  it("an anonymous caller is UNAUTHORIZED", async () => {
    const { caller } = setup({ userId: null, emails: [] });
    await expect(caller.listApiKeys()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("a signed-in non-admin is FORBIDDEN", async () => {
    const { caller } = setup({ userId: "u2", emails: ["bob@example.com"] });
    await expect(caller.revokeApiKey({ id: "k1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a non-admin is rejected before input is parsed", async () => {
    const { caller } = setup({ userId: "u2", emails: ["bob@example.com"] });
    // Invalid input: were it parsed first, this would be BAD_REQUEST.
    await expect(
      caller.createApiKey({
        name: "x",
        scope: "root" as "read",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an admin's bad scope is BAD_REQUEST with the source's message", async () => {
    const { caller } = setup();
    await expect(
      caller.createApiKey({ name: "x", scope: "root" as "read" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      // init.ts's errorFormatter sends this first issue's message as the error message.
      cause: {
        issues: [{ message: 'Expected "scope" to be read, write or full' }],
      },
    });
  });
});

describe("api keys", () => {
  it("creates a dev key off the production origin, with its claude mcp add command", async () => {
    const { caller } = setup();
    const { key, command, info } = await caller.createApiKey({
      name: " Laptop ",
      scope: "write",
    });
    expect(key).toMatch(KEY_RE);
    expect(key.startsWith("cms_dev_")).toBe(true);
    expect(info).toMatchObject({
      name: "Laptop",
      scope: "write",
      createdBy: "u1",
      revokedAt: null,
    });
    expect(command).toBe(
      `claude mcp add --transport http my-site http://localhost:3000/mcp --header "Authorization: Bearer ${key}"`
    );
  });

  it("creates a live key on the production origin", async () => {
    const { caller } = setup({ requestOrigin: SITE });
    const { key } = await caller.createApiKey({ name: "Prod", scope: "full" });
    expect(key.startsWith("cms_live_")).toBe(true);
  });

  it("lists keys and connections with this origin's MCP URL", async () => {
    const { caller } = setup();
    const { info } = await caller.createApiKey({ name: "One", scope: "read" });
    expect(await caller.listApiKeys()).toEqual({
      keys: [info],
      connections: [],
      mcpUrl: "http://localhost:3000/mcp",
    });
  });

  it("revokes a key once", async () => {
    const { caller } = setup();
    const { info } = await caller.createApiKey({ name: "One", scope: "read" });
    expect(await caller.revokeApiKey({ id: info.id })).toEqual({
      revoked: true,
    });
    expect(await caller.revokeApiKey({ id: info.id })).toEqual({
      revoked: false,
    });
    const { keys } = await caller.listApiKeys();
    expect(keys[0]?.revokedAt).not.toBeNull();
  });

  it("lists a key's recent calls, newest first", async () => {
    const { caller, apiKeys } = setup();
    const { info } = await caller.createApiKey({ name: "One", scope: "read" });
    await apiKeys.recordCall({
      keyId: info.id,
      tool: "list_pages",
      target: null,
      ok: true,
      errorCode: null,
      at: 1000,
    });
    await apiKeys.recordCall({
      keyId: info.id,
      tool: "get_page",
      target: "about",
      ok: false,
      errorCode: "NOT_FOUND",
      at: 2000,
    });
    const { calls } = await caller.apiKeyCalls({ id: info.id });
    expect(calls.map((c) => c.tool)).toEqual(["get_page", "list_pages"]);
    expect(await caller.apiKeyCalls({ id: info.id, kind: "oauth" })).toEqual({
      calls: [],
    });
  });
});
