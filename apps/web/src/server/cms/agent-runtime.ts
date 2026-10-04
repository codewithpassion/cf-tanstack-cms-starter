// The page agent's per-request wiring (docs/architecture.md, D20): model providers, tool deps,
// the admin service, the turn deps, Search Console and the render target, built from the Worker
// bindings over `cmsServices`. Nothing in @repo/services reads `env`; this file and the adapters
// it calls are where the agent meets the bindings. Building it does no I/O and creates no model
// client: those are made when a turn or an alt-text call needs one.
import { createAgentAdminService } from "@repo/services/agent/admin-service";
import {
  type AltSuggestion,
  suggestAltText,
} from "@repo/services/agent/alt-text";
import type { ProviderAvailability } from "@repo/services/agent/models";
import type { AgentRenderDeps } from "@repo/services/agent/render-auth";
import type { ToolDeps } from "@repo/services/agent/tools";
import type { TurnDeps } from "@repo/services/agent/turn";
import type { createGscAdmin } from "@repo/services/gsc/admin";
import {
  describeWithClaude,
  readMediaBytes,
  type VisionClient,
} from "../adapters/alt-text";
import { anthropicClient } from "../adapters/anthropic";
import { modelProviders, providerAvailability } from "../adapters/models";
import { agentToolDeps } from "../adapters/tool-deps";
import type { CmsServices } from "./wiring";

/** The signed-in admin: recorded on overrides, settings, models and reverts. */
export type AgentActor = { userId: string; email: string };

export type AgentRuntime = {
  /** Which providers can run here: ANTHROPIC_API_KEY, the AI binding, `__WORKERS_AI_OFF__`. */
  availability: ProviderAvailability;
  /** The agent's tool deps (pages, media, previews, share images, Search Console). Also the MCP server's. */
  toolDeps: ToolDeps;
  /** Threads, settings, models, changesets and site-wide runs (the `agent`/`agentRuns` routers). */
  admin: ReturnType<typeof createAgentAdminService>;
  /** What `beginTurn`/`stopTurn` need (the `admin.api.agent` SSE route). */
  turnDeps: TurnDeps;
  /** Search Console reads and the two Google calls: the same object as `cms.gsc`. */
  gsc: ReturnType<typeof createGscAdmin>;
  /** `authorizeAgentRender` deps, for `/og-render-agent/<pageId>`. */
  renderTarget: AgentRenderDeps;
  /** The media library's "Suggest alt text" (Claude vision, counted toward the daily cap). Rejects with a user-facing message. */
  suggestAltText: (mediaId: string, context?: string) => Promise<AltSuggestion>;
};

export type AgentRuntimeOptions = {
  actor: AgentActor;
  /** The request being served. Unused today (links use `cms.config.origin`); kept for the contract. */
  request?: Request | null;
};

/** The bindings the agent reads beyond what `cmsServices` already holds. */
export type AgentEnv = Pick<
  Env,
  "ANTHROPIC_API_KEY" | "AI" | "BROWSER" | "CMS_MEDIA"
>;

/** Logs for the turn: one place, so Workers observability shows them. */
const turnLog: NonNullable<TurnDeps["log"]> = {
  error: (message, err) => console.error(message, err),
  info: (message) => console.log(message),
};

export function agentRuntime(
  env: AgentEnv,
  cms: CmsServices,
  options: AgentRuntimeOptions
): AgentRuntime {
  const { actor } = options;
  const { timeZone } = cms.config;
  const availability = providerAvailability(env);
  const toolDeps = agentToolDeps(env, cms);
  const store = cms.agentStore;

  return {
    availability,
    toolDeps,
    admin: createAgentAdminService({
      store,
      cms: cms.pagesDeps,
      availability,
      actor,
      timeZone,
    }),
    turnDeps: {
      store,
      tools: toolDeps,
      cms: cms.pagesDeps,
      availability,
      provider: modelProviders(env, env.CMS_MEDIA, cms.config),
      getMedia: async (id) => {
        const m = await cms.media.getMedia(id);
        return m
          ? {
              id: m.id,
              mime: m.mime,
              width: m.width,
              height: m.height,
              alt: m.alt,
            }
          : null;
      },
      timeZone,
      log: turnLog,
    },
    gsc: cms.gsc,
    renderTarget: {
      signer: cms.signer,
      loadPage: (id) => cms.pages.getPage({ id }),
      loadChangeset: async (id) => {
        const row = await store.getChangeset(id);
        return row
          ? { pageId: row.pageId, proposedDoc: row.proposedDoc }
          : null;
      },
    },
    suggestAltText: (mediaId, context) => {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) {
        return Promise.reject(
          new Error("ANTHROPIC_API_KEY is not set on this environment.")
        );
      }
      return suggestAltText(
        {
          store,
          getMedia: (id) => cms.media.getMedia(id),
          readBytes: readMediaBytes(env.CMS_MEDIA),
          // The SDK's `beta.messages.create` takes these params; its overloads don't narrow to the port.
          describe: describeWithClaude(
            anthropicClient(key) as unknown as VisionClient
          ),
          timeZone,
        },
        mediaId,
        context
      );
    },
  };
}
