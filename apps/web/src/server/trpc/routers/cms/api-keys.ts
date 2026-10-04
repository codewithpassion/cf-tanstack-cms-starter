import type { ConnectionInfo } from "@repo/services/mcp/connections";
import {
  type ApiKeyInfo,
  keyEnvFor,
  type McpCall,
} from "@repo/services/mcp/keys";
import {
  API_SCOPES,
  claudeMcpAddCommand,
  mcpServerName,
} from "@repo/services/mcp/scopes";
import { z } from "zod";
import { adminProcedure, router } from "../../init.ts";

/**
 * /admin/api-keys: keys for the MCP server at `/mcp`, and the OAuth "Connected apps" an admin
 * approved on /oauth/authorize. A key's `live`/`dev` env and its `claude mcp add` command come
 * from the origin the admin is on, matched against SITE_ORIGIN, never from the client.
 */

const idSchema = z
  .string({ error: 'Expected "id" to be a string' })
  .min(1, 'Expected "id" to be a string')
  .max(64, 'Expected "id" to be a string');

const createApiKeyInput = z.object({
  name: z
    .string({ error: 'Expected "name" to be a string' })
    .max(200, 'Expected "name" to be a string'),
  scope: z.enum(API_SCOPES, {
    error: 'Expected "scope" to be read, write or full',
  }),
});

const idInput = z.object({ id: idSchema });

const callsInput = z.object({
  id: idSchema,
  /** "oauth" for a connected app's calls; an API key's otherwise. */
  kind: z.enum(["api-key", "oauth"]).optional(),
});

const CALLS_SHOWN = 50;

export const apiKeysRouter = router({
  /** Every key and connected app, newest first, and this site's MCP URL. */
  listApiKeys: adminProcedure.query(
    async ({
      ctx,
    }): Promise<{
      keys: ApiKeyInfo[];
      connections: ConnectionInfo[];
      mcpUrl: string;
    }> => {
      const { cms } = ctx.services;
      const [keys, connections] = await Promise.all([
        cms.apiKeys.list(),
        cms.connections.list(),
      ]);
      const here = cms.requestOrigin ?? cms.config.origin;
      return { keys, connections, mcpUrl: `${here}/mcp` };
    }
  ),

  /** A new key: shown once, with its `claude mcp add` command. */
  createApiKey: adminProcedure
    .input(createApiKeyInput)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{ key: string; command: string; info: ApiKeyInfo }> => {
        const { cms } = ctx.services;
        const here = cms.requestOrigin ?? cms.config.origin;
        const { key, info } = await cms.apiKeys.create({
          name: input.name,
          scope: input.scope,
          createdBy: ctx.userId,
          env: keyEnvFor(here, cms.siteOriginVar),
        });
        return {
          key,
          command: claudeMcpAddCommand(
            mcpServerName(cms.config.name),
            here,
            key
          ),
          info,
        };
      }
    ),

  /** Revokes a key; it stops working on the next request. */
  revokeApiKey: adminProcedure.input(idInput).mutation(
    async ({ ctx, input }): Promise<{ revoked: boolean }> => ({
      revoked: await ctx.services.cms.apiKeys.revoke(input.id),
    })
  ),

  /** A key's (or, with `kind: "oauth"`, a connected app's) last 50 tool calls. */
  apiKeyCalls: adminProcedure.input(callsInput).query(
    async ({ ctx, input }): Promise<{ calls: McpCall[] }> => ({
      calls: await ctx.services.cms.apiKeys.recentCalls(
        input.id,
        CALLS_SHOWN,
        input.kind ?? "api-key"
      ),
    })
  ),

  /** Disconnects an app: its tokens stop working on the next request, and its grant is revoked. */
  revokeConnection: adminProcedure
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<{ revoked: boolean }> => {
      // Loaded here, not at the top, so tests can import this router without the Workers runtime.
      const [{ env }, { oauthGrantsFor }] = await Promise.all([
        import("cloudflare:workers"),
        import("../../../adapters/oauth-grants.ts"),
      ]);
      const { cms } = ctx.services;
      // The grant lives with the issuer the app signed in at: the origin the admin is on.
      const here = cms.requestOrigin ?? cms.config.origin;
      return {
        revoked: await cms.connections.revoke(
          oauthGrantsFor(env, here),
          input.id
        ),
      };
    }),
});
