import { env, waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { assertAdminApi } from "#/server/cms/admin";
import { cmsServices } from "#/server/cms/wiring";
import { handleAgentStop, handleAgentTurn } from "#/server/routes/agent-stream";

/**
 * The page agent: `POST /admin/api/agent` runs one turn and streams it as server-sent events;
 * `DELETE /admin/api/agent?threadId=…` is Stop. Admin only and same-origin only, both checked
 * before the body is read. Transport: server/routes/agent-stream.ts; the turn: services
 * agent/turn.ts over the request's agent runtime (server/cms/agent-runtime.ts), loaded on demand.
 */
export const Route = createFileRoute("/admin/api/agent")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleAgentTurn(request, {
          assertAdmin: assertAdminApi,
          beginTurn: async (admin, body) => {
            const [{ agentRuntime }, { beginTurn }] = await Promise.all([
              import("#/server/cms/agent-runtime"),
              import("@repo/services/agent/turn"),
            ]);
            const cms = cmsServices(env, { author: admin.userId, request });
            const { turnDeps } = agentRuntime(env, cms, {
              actor: admin,
              request,
            });
            return beginTurn(turnDeps, { body, userId: admin.userId });
          },
          waitUntil,
          log: console,
        }),
      DELETE: ({ request }) =>
        handleAgentStop(request, {
          assertAdmin: assertAdminApi,
          stop: async (threadId) => {
            const { stopTurn } = await import("@repo/services/agent/turn");
            return stopTurn(cmsServices(env, { request }).agentStore, threadId);
          },
        }),
    },
  },
});
