// biome-ignore-all lint/performance/noDelete: drops `$schema` from a fresh JSON Schema object once per tool.
import { OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { createD1MediaRepo } from "@repo/db/media";
import { createSiteD1Repo } from "@repo/db/site";
import type { ConnectionProps } from "@repo/services/mcp/connections";
import {
  bearerKey,
  type McpIdentity,
  principalOf,
} from "@repo/services/mcp/keys";
import { fromOAuthScopes, mcpServerName } from "@repo/services/mcp/scopes";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { cmsServices } from "../cms/wiring";
import {
  authorizationServerFor,
  libraryContext,
  mcpResourceFor,
} from "./oauth";
import { authorOf, callMcpTool, type McpDeps, mcpToolList } from "./tools";

/** The largest JSON-RPC request taken (a base64 `upload_media` of a 10 MB image is about 13.4 MB). */
export const MAX_REQUEST_BYTES = 15 * 1024 * 1024;

/**
 * What every API key starts with (`cms_live_` or `cms_dev_`, @repo/services/mcp/keys). An OAuth
 * access token is `<userId>:<grantId>:<secret>`, so it never does.
 */
const API_KEY_PREFIX = "cms_";

/**
 * `/mcp` (src/routes/mcp.ts) and its RFC 9728 metadata (`/.well-known/oauth-protected-resource/mcp`,
 * routed here by ./oauth.ts `handleOAuthEndpoint`): the library's `OAuthResourceServer` for
 * `<origin>/mcp`, which answers a request without a bearer token, or with an invalid one, with a
 * 401 challenge naming the metadata, so OAuth clients find the sign-in. Behind it, the stateless
 * Streamable HTTP handler from Cloudflare's `agents` package, with a fresh MCP server per request
 * (no Durable Object, no session).
 * A body over 15 MB gets 413 (by Content-Length before the credential check, by reading it after).
 * Where the library refuses the origin (plain http off loopback, e.g. a Tailscale dev origin),
 * `/mcp` takes API keys only.
 */
export async function handleMcpRequest(
  env: Env,
  request: Request
): Promise<Response> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_REQUEST_BYTES) {
    return tooLarge();
  }
  const server = resourceServerFor(env, new URL(request.url).origin);
  if (server) {
    return await server.fetch(request, env, libraryContext());
  }
  const key = await cmsServices(env, { request }).apiKeys.verify(
    bearerKey(request)
  );
  return key
    ? await serveMcp(env, request, { ...key, kind: "api-key" })
    : unauthorized(env);
}

const resourceServers = new Map<
  string,
  OAuthResourceServer<Env, McpIdentity> | null
>();

function resourceServerFor(
  env: Env,
  origin: string
): OAuthResourceServer<Env, McpIdentity> | null {
  if (resourceServers.has(origin)) {
    return resourceServers.get(origin) ?? null;
  }
  const server = authorizationServerFor(origin)
    ? new OAuthResourceServer<Env, McpIdentity>({
        resourceMetadata: {
          resource: mcpResourceFor(origin),
          authorization_servers: [origin],
          resource_name: env.SITE_NAME,
        },
        // No requiredScopes: the consent page picks the scope (default write), so the 401 names none.
        validateToken: (bindings) => (resource, token) =>
          validateMcpToken(bindings, resource, token),
        handler: {
          fetch: (req, bindings, ctx) => serveMcp(bindings, req, ctx.props),
        },
      })
    : null;
  resourceServers.set(origin, server);
  return server;
}

/**
 * Both credential kinds. A `cms_` bearer is an API key, so it is never sent to the OAuth store;
 * anything else must be an access token the authorization server issued for this host's `/mcp`,
 * whose connection row isn't revoked. Null → the 401 challenge.
 */
export async function validateMcpToken(
  env: Env,
  resource: string,
  token: string,
  now = Date.now()
) {
  // The resource is `<request origin>/mcp`: it stands in for the request, whose origin is the site
  // origin in dev when SITE_ORIGIN is empty.
  const services = cmsServices(env, { request: new Request(resource) });
  if (token.startsWith(API_KEY_PREFIX)) {
    const key = await services.apiKeys.verify(token, now);
    return key
      ? { props: { ...key, kind: "api-key" as const }, audience: resource }
      : null;
  }
  const validated = await authorizationServerFor(
    new URL(resource).origin
  )?.validateToken<ConnectionProps>(resource, token, env);
  if (!validated) {
    return null;
  }
  const scope = fromOAuthScopes(validated.scope);
  if (!scope || typeof validated.props?.connectionId !== "string") {
    return null;
  }
  // Tokens are `<userId>:<grantId>:<secret>`.
  const grantId = token.split(":")[1] ?? null;
  const who = await services.connections.verify(
    {
      connectionId: validated.props.connectionId,
      userId: validated.userId,
      grantId,
      scope,
    },
    now
  );
  return who
    ? {
        props: who,
        audience: validated.audience,
        expiresAt: validated.expiresAt,
        scope: validated.scope,
        userId: validated.userId,
        clientId: validated.clientId,
      }
    : null;
}

/** The MCP server for a caller that passed the credential check. */
async function serveMcp(
  env: Env,
  incoming: Request,
  who: McpIdentity
): Promise<Response> {
  let request = incoming;
  // Without a Content-Length (chunked), read the body here up to the limit.
  if (request.body && !request.headers.has("Content-Length")) {
    const body = await readLimited(request.body, MAX_REQUEST_BYTES);
    if (!body) {
      return tooLarge();
    }
    request = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    });
  }
  const deps = mcpDeps(env, who, request);
  const name = mcpServerName(env.SITE_NAME);
  // No CORS from the MCP SDK (the resource server adds its own). `.fetch` needs no ExecutionContext.
  return await createMcpHandler(() => mcpServer(deps, name, env.SITE_NAME), {
    route: "/mcp",
    corsOptions: false,
  }).fetch(request);
}

/**
 * The tools' dependencies. Absolute links (previews, published URLs, editor links) use the site
 * origin (`SITE_ORIGIN`; the request origin only in dev), not whatever host the request came in on.
 */
export function mcpDeps(
  env: Env,
  key: McpIdentity,
  request: Request | null = null
): McpDeps {
  const services = cmsServices(env, { request, author: authorOf(key) });
  return {
    key,
    origin: services.config.origin,
    // TODO(cms-port-agent): the agent's ToolDeps (web port of the source's agent/server/wiring.ts
    // `toolDeps(env, origin)`: render previews, share images, Search Console, preview links).
    // Until it lands, the agent tools answer NOT_AVAILABLE (tools.ts `viaAgent`).
    tools: null,
    store: services.agentStore,
    cms: services.pagesDeps,
    site: {
      repo: createSiteD1Repo(services.db),
      kv: services.kv,
      config: services.config,
      author: authorOf(key),
    },
    media: { repo: createD1MediaRepo(services.db), blobs: env.CMS_MEDIA },
    log: (call) =>
      services.apiKeys.recordCall({ ...principalOf(key), ...call }),
  };
}

/**
 * Inputs are validated by `callMcpTool` (after the scope check, so a refused call is logged too):
 * the SDK gets each tool's JSON Schema for `tools/list` and a validator that lets every input through.
 */
const passThrough = {
  getValidator: () => (input: unknown) => ({
    valid: true as const,
    data: input as never,
    errorMessage: undefined,
  }),
};

function mcpServer(deps: McpDeps, name: string, siteName: string) {
  const server = new McpServer(
    { name, version: "1.0.0" },
    {
      instructions: `${siteName.trim() || "This site"}'s CMS. Pages are edited as drafts with an optimistic draftVersion (re-read the page after STALE_DRAFT). Proposals from the built-in agent and from propose_ops/propose_seo wait in the review queue. Publishing changes the live site.`,
    }
  );
  for (const tool of mcpToolList()) {
    const schema = z.toJSONSchema(tool.input, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    delete schema.$schema;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(schema as never, passThrough),
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.scope === "full",
        },
      },
      async (args: unknown) => callMcpTool(deps, tool.name, args)
    );
  }
  return server;
}

/** The body's bytes, or null once it passes `max`. */
async function readLimited(
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: the stream is read chunk by chunk.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

function tooLarge(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32_600, message: "Request too large (at most 15 MB)." },
      id: null,
    },
    { status: 413 }
  );
}

function unauthorized(env: Env): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32_001,
        message:
          "Missing, unknown or revoked API key. Create one in /admin/api-keys and send it as Authorization: Bearer <key>.",
      },
      id: null,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="${mcpServerName(env.SITE_NAME)}"`,
      },
    }
  );
}
