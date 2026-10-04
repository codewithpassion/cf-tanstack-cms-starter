import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { oauthConnections } from "@repo/db";

import { oauthGrantsFor } from "../adapters/oauth-grants";
import type { AdminCheck } from "../cms/admin";
import {
  browserSignedIn,
  consentCsp,
  handleAuthorize,
  REAPPROVE_NOTICE,
} from "./authorize";
import { handleMcpRequest, validateMcpToken } from "./handler";
import { handleOAuthEndpoint } from "./oauth";
import { createTestEnv, TEST_ORIGIN, TEST_SITE_NAME } from "./test-env";

const ORIGIN = TEST_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const ADMIN: AdminCheck = {
  ok: true,
  userId: "user_admin",
  email: "admin@example.com",
};
const LOOPBACK_CB = "http://localhost:33418/callback";
const HANDLE_RE = /name="handle" value="([^"]+)"/;
const CLAUDE_NAME_RE = /^Claude \(/;

/** Anthropic's published client identity, as Claude.ai presents it (shape of a CIMD document). */
const CLAUDE_CIMD_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const claudeDocument = {
  client_id: CLAUDE_CIMD_URL,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: [CLAUDE_CB],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value");
  }
  return value;
}

/** For the helpers below: a step that went wrong stops the test there. */
function ensureStatus(res: Response, status: number): void {
  if (res.status !== status) {
    throw new Error(`Expected HTTP ${status}, got ${res.status}`);
  }
}

const TRAILING_PADDING_RE = /[=]+$/;

function setup() {
  const { env, services } = createTestEnv();
  let n = 0;
  const authorize = (request: Request, check: AdminCheck = ADMIN) =>
    handleAuthorize(request, {
      env,
      connections: services.connections,
      siteName: TEST_SITE_NAME,
      check: () => Promise.resolve(check),
      genId: () => {
        n += 1;
        return `conn${n}`;
      },
    });
  return { db: services.db, env, services, authorize };
}
type Ctx = ReturnType<typeof setup>;

/** The library's endpoints, as src/server.ts routes them. */
async function endpoint(env: Env, request: Request): Promise<Response> {
  return must(await handleOAuthEndpoint(env, request));
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(TRAILING_PADDING_RE, "");

async function pkce() {
  const verifier = `${"v".repeat(20)}${crypto.randomUUID()}${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: b64url(digest) };
}

function authorizeUrl(
  clientId: string,
  redirectUri: string,
  challenge: string
) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "st8",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  return `${ORIGIN}/oauth/authorize?${q}`;
}

async function register(env: Env, redirectUri = LOOPBACK_CB): Promise<string> {
  const res = await endpoint(
    env,
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test MCP client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  );
  ensureStatus(res, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** A confidential DCR client (client_secret_post): the library doesn't require PKCE of these. */
async function registerConfidential(
  env: Env
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await endpoint(
    env,
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Confidential client",
        redirect_uris: [LOOPBACK_CB],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  );
  ensureStatus(res, 201);
  const body = (await res.json()) as {
    client_id: string;
    client_secret: string;
  };
  return { clientId: body.client_id, clientSecret: must(body.client_secret) };
}

/** GET the consent page, then POST the form back with the binding cookie. */
async function consent(
  authorize: (r: Request) => Promise<Response>,
  url: string,
  form: Record<string, string>
) {
  const page = await authorize(new Request(url));
  ensureStatus(page, 200);
  const html = await page.text();
  const handle = must(HANDLE_RE.exec(html)?.[1]);
  const cookie = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await authorize(
    new Request(url, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
      },
      body: new URLSearchParams({ handle, ...form }),
    })
  );
  return { page, html, res };
}

const tokenRequest = (body: Record<string, string>) =>
  new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

async function exchange(
  env: Env,
  clientId: string,
  redirectUri: string,
  code: string,
  verifier: string
) {
  const res = await endpoint(
    env,
    tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    })
  );
  ensureStatus(res, 200);
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
}

const locationOf = (res: Response) =>
  new URL(must(res.headers.get("Location")));

/** Register (DCR), consent with `scope`, exchange the code: an access token for /mcp. */
async function connectDcr(ctx: Ctx, scope = "write") {
  const clientId = await register(ctx.env);
  const { verifier, challenge } = await pkce();
  const { res } = await consent(
    ctx.authorize,
    authorizeUrl(clientId, LOOPBACK_CB, challenge),
    { decision: "approve", scope }
  );
  ensureStatus(res, 302);
  const location = locationOf(res);
  const tokens = await exchange(
    ctx.env,
    clientId,
    LOOPBACK_CB,
    must(location.searchParams.get("code")),
    verifier
  );
  return { clientId, location, tokens };
}

const mcpPost = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
      },
    }),
  });

describe("discovery", () => {
  it("publishes RFC 8414 metadata for this host, with CIMD and DCR", async () => {
    const { env } = setup();
    const res = await endpoint(
      env,
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      scopes_supported: ["cms:read", "cms:write", "cms:full"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      protected_resources: [RESOURCE],
    });
  });

  it("publishes RFC 9728 metadata at /.well-known/oauth-protected-resource/mcp", async () => {
    const { env } = setup();
    const res = await endpoint(
      env,
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      bearer_methods_supported: ["header"],
    });
  });

  it("leaves every other path, and /oauth/authorize, to the app", async () => {
    const { env } = setup();
    for (const path of ["/oauth/authorize", "/.well-known/security.txt"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps failures readable.
      expect(await handleOAuthEndpoint(env, new Request(ORIGIN + path))).toBe(
        null
      );
    }
  });

  it("answers /mcp without credentials, or with a bad token, with the 401 challenge", async () => {
    const { env } = setup();
    const challenge = `Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;
    const none = await handleMcpRequest(env, mcpPost(RESOURCE));
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe(challenge);
    const bad = await handleMcpRequest(
      env,
      mcpPost(RESOURCE, { Authorization: "Bearer user_x:grant:nope" })
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"'
    );
    const badKey = await handleMcpRequest(
      env,
      mcpPost(RESOURCE, { Authorization: `Bearer cms_live_${"a".repeat(32)}` })
    );
    expect(badKey.status).toBe(401);
  });
});

describe("an origin the library can't issue for (plain http off loopback)", () => {
  const PLAIN_HTTP = "http://100.64.0.1:3000";

  it("has no OAuth endpoints, and /mcp takes API keys as before", async () => {
    const { env, services } = setup();
    expect(
      await handleOAuthEndpoint(
        env,
        new Request(`${PLAIN_HTTP}/.well-known/oauth-authorization-server`)
      )
    ).toBeNull();
    const none = await handleMcpRequest(env, mcpPost(`${PLAIN_HTTP}/mcp`));
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="example-site"'
    );
    const { key } = await services.apiKeys.create({
      name: "laptop",
      scope: "read",
      createdBy: null,
      env: "dev",
    });
    const ok = await handleMcpRequest(
      env,
      mcpPost(`${PLAIN_HTTP}/mcp`, { Authorization: `Bearer ${key}` })
    );
    expect(ok.status).toBe(200);
  });

  it("shows a plain error on /oauth/authorize", async () => {
    const ctx = setup();
    const res = await ctx.authorize(
      new Request(`${PLAIN_HTTP}/oauth/authorize?client_id=x`)
    );
    expect(res.status).toBe(404);
  });
});

describe("/oauth/authorize", () => {
  it("sends a signed-out browser to /login, back to this exact path", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const url = authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge);
    const res = await ctx.authorize(new Request(url), {
      ok: false,
      status: 401,
      message: "Sign in required.",
    });
    expect(res.status).toBe(302);
    const to = new URL(must(res.headers.get("Location")), ORIGIN);
    expect(to.pathname).toBe("/login");
    const back = new URL(url);
    expect(to.searchParams.get("redirect_url")).toBe(
      back.pathname + back.search
    );
  });

  it("refuses a signed-in user who isn't on ADMIN_EMAILS, before any consent", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const res = await ctx.authorize(
      new Request(
        authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge)
      ),
      {
        ok: false,
        status: 403,
        message: "Your account does not have admin access.",
      }
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(
      "Your account does not have admin access."
    );
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("shows the consent page: client name, redirect host, loopback warning, write by default", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const res = await ctx.authorize(
      new Request(authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge))
    );
    const html = await res.text();
    expect(html).toContain("Connect Test MCP client to the Example Site CMS?");
    expect(html).toContain("registered itself");
    expect(html).toContain("<strong>localhost</strong>");
    expect(html).toContain("an app on your computer");
    expect(html).toContain('value="write" checked');
    expect(html).toContain("admin@example.com");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' http://localhost:33418; frame-ancestors 'none'; base-uri 'none'"
    );
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.getSetCookie()[0]).toStartWith("__Host-oauth-consent-");
  });

  it("renders an unknown client or a wrong redirect URI locally, never redirecting", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const wrong = await ctx.authorize(
      new Request(
        authorizeUrl(
          clientId,
          "https://evil.example/cb",
          (await pkce()).challenge
        )
      )
    );
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("Location")).toBeNull();
    const unknown = await ctx.authorize(
      new Request(authorizeUrl("nope", LOOPBACK_CB, (await pkce()).challenge))
    );
    expect(unknown.status).toBe(400);
  });

  it("Deny sends access_denied back to the client and writes no connection", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const { res } = await consent(
      ctx.authorize,
      authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge),
      { decision: "deny", scope: "write" }
    );
    expect(res.status).toBe(302);
    const to = locationOf(res);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st8");
    expect(await ctx.services.connections.list()).toEqual([]);
  });

  it("a form posted without the browser's binding cookie is refused", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const url = authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge);
    const html = await (await ctx.authorize(new Request(url))).text();
    const handle = must(HANDLE_RE.exec(html)?.[1]);
    const res = await ctx.authorize(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          handle,
          decision: "approve",
          scope: "full",
        }),
      })
    );
    expect(res.status).toBe(400);
    expect(await ctx.services.connections.list()).toEqual([]);
  });

  it("checks the admin before reading a posted form", async () => {
    const ctx = setup();
    const request = new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "handle=x&decision=approve&scope=full",
    });
    const res = await ctx.authorize(request, {
      ok: false,
      status: 403,
      message: "Your account does not have admin access.",
    });
    expect(res.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
  });
});

describe("PKCE for every client", () => {
  it("refuses a confidential client without code_challenge, back to the client as invalid_request", async () => {
    const ctx = setup();
    const { clientId } = await registerConfidential(ctx.env);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: LOOPBACK_CB,
      state: "st8",
      resource: RESOURCE,
    });
    const res = await ctx.authorize(
      new Request(`${ORIGIN}/oauth/authorize?${q}`)
    );
    expect(res.status).toBe(302);
    const to = locationOf(res);
    expect(`${to.origin}${to.pathname}`).toBe(LOOPBACK_CB);
    expect(to.searchParams.get("error")).toBe("invalid_request");
    expect(to.searchParams.get("error_description")).toBe(
      "PKCE (S256) is required"
    );
    expect(to.searchParams.get("state")).toBe("st8");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("lets a confidential client with S256 through to a token", async () => {
    const ctx = setup();
    const { clientId, clientSecret } = await registerConfidential(ctx.env);
    const { verifier, challenge } = await pkce();
    const { res } = await consent(
      ctx.authorize,
      authorizeUrl(clientId, LOOPBACK_CB, challenge),
      { decision: "approve", scope: "read" }
    );
    expect(res.status).toBe(302);
    const code = must(locationOf(res).searchParams.get("code"));
    const token = await endpoint(
      ctx.env,
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: LOOPBACK_CB,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        resource: RESOURCE,
      })
    );
    expect(token.status).toBe(200);
    expect(
      ((await token.json()) as { access_token?: string }).access_token
    ).toBeString();
  });
});

/** The consent page's handle and binding cookie, plus extra cookies for the POST. */
async function openConsent(ctx: Ctx, url: string) {
  const page = await ctx.authorize(new Request(url));
  ensureStatus(page, 200);
  const handle = must(HANDLE_RE.exec(await page.text())?.[1]);
  const cookie = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { handle, cookie };
}

function approvePost(url: string, handle: string, cookie: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
    },
    body: new URLSearchParams({ handle, decision: "approve", scope: "write" }),
  });
}

const SIGNED_OUT: AdminCheck = {
  ok: false,
  status: 401,
  message: "Sign in required.",
};
/** Clerk's development cookie: the client signed in at this time (seconds). */
const CLIENT_UAT = "__client_uat_Ab1-x9=1791028948";
const HTML_ENTITY_RE = /&#(\d+);/g;
const META_REFRESH_RE = /<meta http-equiv="refresh" content="0;url=([^"]+)">/;

describe("Approve after the session token expired", () => {
  it("sends a signed-in browser back to the consent page, which approves on the second try", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const { verifier, challenge } = await pkce();
    const url = authorizeUrl(clientId, LOOPBACK_CB, challenge);
    const { handle, cookie } = await openConsent(ctx, url);

    // The page sat open: the POST carries the client cookie but no valid session token.
    const res = await ctx.authorize(
      approvePost(url, handle, `${cookie}; ${CLIENT_UAT}`),
      SIGNED_OUT
    );
    expect(res.status).toBe(200);
    const refresh = must(META_REFRESH_RE.exec(await res.text())?.[1]);
    const back = new URL(
      refresh.replace(HTML_ENTITY_RE, (_, entity: string) =>
        String.fromCharCode(Number(entity))
      ),
      ORIGIN
    );
    expect(back.pathname).toBe("/oauth/authorize");
    expect(back.searchParams.get("reapprove")).toBe("1");
    expect(back.searchParams.get("code_challenge")).toBe(challenge);
    expect(await ctx.db.select().from(oauthConnections)).toEqual([]);

    // The GET (refreshed by Clerk's handshake) asks again; Approve then completes.
    const again = await consent(ctx.authorize, back.toString(), {
      decision: "approve",
      scope: "write",
    });
    expect(again.html).toContain(REAPPROVE_NOTICE);
    ensureStatus(again.res, 302);
    const code = must(locationOf(again.res).searchParams.get("code"));
    const tokens = await exchange(
      ctx.env,
      clientId,
      LOOPBACK_CB,
      code,
      verifier
    );
    expect(tokens.access_token).toBeString();
    expect(await ctx.db.select().from(oauthConnections)).toHaveLength(1);
  });

  it("still refuses a browser that is signed out, and writes nothing", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const url = authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge);
    const { handle, cookie } = await openConsent(ctx, url);
    for (const extra of ["", "; __client_uat=0"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two cases on the same handle, in order.
      const res = await ctx.authorize(
        approvePost(url, handle, cookie + extra),
        SIGNED_OUT
      );
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Your admin session ended");
    }
    expect(await ctx.db.select().from(oauthConnections)).toEqual([]);
  });

  it("a non-admin's POST writes nothing either, and the handle still works for the admin", async () => {
    const ctx = setup();
    const clientId = await register(ctx.env);
    const url = authorizeUrl(clientId, LOOPBACK_CB, (await pkce()).challenge);
    const { handle, cookie } = await openConsent(ctx, url);
    const refused = await ctx.authorize(approvePost(url, handle, cookie), {
      ok: false,
      status: 403,
      message: "Your account does not have admin access.",
    });
    expect(refused.status).toBe(403);
    expect(await ctx.db.select().from(oauthConnections)).toEqual([]);
    const ok = await ctx.authorize(approvePost(url, handle, cookie));
    expect(ok.status).toBe(302);
    expect(await ctx.db.select().from(oauthConnections)).toHaveLength(1);
  });

  it("browserSignedIn reads Clerk's client cookie, with or without the instance suffix", () => {
    const req = (cookie?: string) =>
      new Request(ORIGIN, cookie ? { headers: { Cookie: cookie } } : {});
    expect(browserSignedIn(req(CLIENT_UAT))).toBe(true);
    expect(browserSignedIn(req("a=1; __client_uat=1791028948"))).toBe(true);
    expect(browserSignedIn(req("__client_uat=0"))).toBe(false);
    expect(browserSignedIn(req("__client_uat_x=0; other=5"))).toBe(false);
    expect(browserSignedIn(req("not__client_uat=5"))).toBe(false);
    expect(browserSignedIn(req())).toBe(false);
  });
});

describe("connections and /mcp identity", () => {
  it("DCR end to end: approve → connection row → token → identity with the chosen scope", async () => {
    const ctx = setup();
    const { clientId, location, tokens } = await connectDcr(ctx, "read");
    expect(location.origin + location.pathname).toBe(LOOPBACK_CB);
    expect(location.searchParams.get("state")).toBe("st8");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(tokens.scope).toBe("cms:read");
    const [conn] = await ctx.services.connections.list();
    expect(conn).toMatchObject({
      id: "conn1",
      clientId,
      clientName: "Test MCP client",
      redirectUri: LOOPBACK_CB,
      email: "admin@example.com",
      scope: "read",
      revokedAt: null,
      lastUsedAt: null,
    });
    const v = await validateMcpToken(ctx.env, RESOURCE, tokens.access_token);
    expect(v?.props).toEqual({
      id: "conn1",
      name: must(conn).name,
      scope: "read",
      kind: "oauth",
    });
    const [row] = await ctx.db.select().from(oauthConnections);
    expect(row?.grantId).toBe(tokens.access_token.split(":")[1]);
    expect(row?.lastUsedAt).not.toBeNull();
    // Refreshing keeps the scope and the connection.
    const refresh = await endpoint(
      ctx.env,
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      })
    );
    expect(refresh.status).toBe(200);
    const next = (await refresh.json()) as { access_token: string };
    expect(
      (await validateMcpToken(ctx.env, RESOURCE, next.access_token))?.props
    ).toMatchObject({ id: "conn1", scope: "read" });
  });

  it("serves /mcp to the token and logs calls by connection", async () => {
    const ctx = setup();
    const { tokens } = await connectDcr(ctx);
    const res = await handleMcpRequest(
      ctx.env,
      mcpPost(RESOURCE, { Authorization: `Bearer ${tokens.access_token}` })
    );
    expect(res.status).toBe(200);
    await ctx.services.apiKeys.recordCall({
      connectionId: "conn1",
      tool: "get_site",
      target: null,
      ok: true,
      errorCode: null,
    });
    expect(
      await ctx.services.apiKeys.recentCalls("conn1", 50, "oauth")
    ).toMatchObject([{ tool: "get_site", ok: true }]);
    expect(await ctx.services.apiKeys.recentCalls("conn1")).toEqual([]);
  });

  it("a token is only good for the host that issued it", async () => {
    const ctx = setup();
    const { tokens } = await connectDcr(ctx);
    const other = "https://www.example.com/mcp";
    expect(
      await validateMcpToken(ctx.env, other, tokens.access_token)
    ).toBeNull();
    const res = await handleMcpRequest(
      ctx.env,
      mcpPost(other, { Authorization: `Bearer ${tokens.access_token}` })
    );
    expect(res.status).toBe(401);
  });

  it("Revoke: the next request gets the 401, and the grant is gone from OAUTH_KV", async () => {
    const ctx = setup();
    const { clientId, tokens } = await connectDcr(ctx);
    expect(
      await ctx.services.connections.revoke(
        oauthGrantsFor(ctx.env, ORIGIN),
        "conn1"
      )
    ).toBe(true);
    expect(
      await validateMcpToken(ctx.env, RESOURCE, tokens.access_token)
    ).toBeNull();
    const res = await handleMcpRequest(
      ctx.env,
      mcpPost(RESOURCE, { Authorization: `Bearer ${tokens.access_token}` })
    );
    expect(res.status).toBe(401);
    const refresh = await endpoint(
      ctx.env,
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      })
    );
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (await ctx.services.connections.list())[0]?.revokedAt
    ).not.toBeNull();
    expect(
      await ctx.services.connections.revoke(
        oauthGrantsFor(ctx.env, ORIGIN),
        "conn1"
      )
    ).toBe(false);
  });

  it("a revoked row alone is enough to refuse the token", async () => {
    const ctx = setup();
    const { tokens } = await connectDcr(ctx);
    await ctx.db.update(oauthConnections).set({ revokedAt: new Date() });
    expect(
      await validateMcpToken(ctx.env, RESOURCE, tokens.access_token)
    ).toBeNull();
  });

  it("API keys are unchanged: cms_ keys never reach the OAuth store", async () => {
    const ctx = setup();
    const get = spyOn(ctx.env.OAUTH_KV, "get");
    const { key, info } = await ctx.services.apiKeys.create({
      name: "laptop",
      scope: "full",
      createdBy: "user_admin",
      env: "live",
    });
    expect((await validateMcpToken(ctx.env, RESOURCE, key))?.props).toEqual({
      id: info.id,
      name: "laptop",
      prefix: info.prefix,
      scope: "full",
      kind: "api-key",
    });
    const ok = await handleMcpRequest(
      ctx.env,
      mcpPost(RESOURCE, { Authorization: `Bearer ${key}` })
    );
    expect(ok.status).toBe(200);
    await ctx.services.apiKeys.revoke(info.id);
    expect(await validateMcpToken(ctx.env, RESOURCE, key)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Client ID Metadata Documents (Claude's published identity)", () => {
  function stubCimd(doc: unknown = claudeDocument) {
    const fetch = mock((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== CLAUDE_CIMD_URL) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        Response.json(doc, { headers: { "Cache-Control": "max-age=300" } })
      );
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    return fetch;
  }

  it("fetches the document, shows Claude and its domain, and completes the grant", async () => {
    const ctx = setup();
    const fetch = stubCimd();
    const { verifier, challenge } = await pkce();
    const url = authorizeUrl(CLAUDE_CIMD_URL, CLAUDE_CB, challenge);
    const { page, html, res } = await consent(ctx.authorize, url, {
      decision: "approve",
      scope: "write",
    });
    expect(fetch).toHaveBeenCalled();
    expect(html).toContain("Connect Claude to the Example Site CMS?");
    expect(html).toContain("Published by <strong>claude.ai</strong>");
    expect(html).not.toContain("an app on your computer");
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://claude.ai;"
    );
    expect(res.status).toBe(302);
    const to = locationOf(res);
    expect(to.origin + to.pathname).toBe(CLAUDE_CB);
    const tokens = await exchange(
      ctx.env,
      CLAUDE_CIMD_URL,
      CLAUDE_CB,
      must(to.searchParams.get("code")),
      verifier
    );
    expect(
      (await validateMcpToken(ctx.env, RESOURCE, tokens.access_token))?.props
    ).toMatchObject({
      kind: "oauth",
      scope: "write",
      name: expect.stringMatching(CLAUDE_NAME_RE),
    });
    expect(await ctx.services.connections.list()).toMatchObject([
      {
        clientId: CLAUDE_CIMD_URL,
        clientName: "Claude",
        redirectUri: CLAUDE_CB,
      },
    ]);
  });

  it("refuses a redirect URI the document doesn't list, without redirecting", async () => {
    const ctx = setup();
    stubCimd();
    const res = await ctx.authorize(
      new Request(
        authorizeUrl(
          CLAUDE_CIMD_URL,
          "https://evil.example/cb",
          (await pkce()).challenge
        )
      )
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("refuses a document whose client_id isn't its own URL", async () => {
    const ctx = setup();
    stubCimd({ ...claudeDocument, client_id: "https://evil.example/meta" });
    const res = await ctx.authorize(
      new Request(
        authorizeUrl(CLAUDE_CIMD_URL, CLAUDE_CB, (await pkce()).challenge)
      )
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Can&#39;t connect");
  });

  it("connecting again replaces the earlier connection (same client and redirect URI)", async () => {
    const ctx = setup();
    stubCimd();
    const tokens: { access_token: string }[] = [];
    for (const scope of ["read", "full"]) {
      // biome-ignore lint/performance/noAwaitInLoops: the second approval must follow the first.
      const { verifier, challenge } = await pkce();
      const { res } = await consent(
        ctx.authorize,
        authorizeUrl(CLAUDE_CIMD_URL, CLAUDE_CB, challenge),
        { decision: "approve", scope }
      );
      tokens.push(
        await exchange(
          ctx.env,
          CLAUDE_CIMD_URL,
          CLAUDE_CB,
          must(locationOf(res).searchParams.get("code")),
          verifier
        )
      );
    }
    const [newer, older] = await ctx.services.connections.list();
    expect([newer?.scope, newer?.revokedAt]).toEqual(["full", null]);
    expect([older?.scope, older?.revokedAt === null]).toEqual(["read", false]);
    expect(
      await validateMcpToken(ctx.env, RESOURCE, must(tokens[0]).access_token)
    ).toBeNull();
    expect(
      (await validateMcpToken(ctx.env, RESOURCE, must(tokens[1]).access_token))
        ?.props.scope
    ).toBe("full");
  });
});

describe("consent CSP", () => {
  it("allows the form post's redirect to the client's origin only", () => {
    expect(consentCsp("https://claude.ai/api/mcp/auth_callback")).toContain(
      "form-action 'self' https://claude.ai;"
    );
    expect(consentCsp("http://127.0.0.1:5000/cb")).toContain(
      "form-action 'self' http://127.0.0.1:5000;"
    );
    expect(consentCsp("not a url")).toContain("form-action 'self';");
  });
});
