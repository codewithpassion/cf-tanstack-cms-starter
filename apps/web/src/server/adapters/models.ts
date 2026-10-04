import type { ModelRef } from "@repo/cms-core/agent/models";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { anthropicProvider } from "@repo/services/agent/anthropic";
import {
  type ProviderAvailability,
  type ProviderFactories,
  providerFor,
} from "@repo/services/agent/models";
import type { ModelProvider } from "@repo/services/agent/provider";
import { workersAiProvider } from "@repo/services/agent/workers-ai";
import { agentClient, hydrator, type ImageBlobs } from "./anthropic";
import {
  WORKERS_AI_OFF_REASON,
  workersAiBinding,
  workersAiOff,
} from "./workers-ai";

/**
 * Which agent models can run on this Worker, and the concrete providers. Claude needs
 * ANTHROPIC_API_KEY; Workers AI needs the `AI` binding, which always runs remotely (see
 * `workersAiOff`). The availability rules themselves are `@repo/services/agent/models`.
 */

export type ModelEnv = {
  ANTHROPIC_API_KEY?: string;
  AI?: unknown;
};

export function providerAvailability(env: ModelEnv): ProviderAvailability {
  const off = workersAiOff();
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    workersAi: workersAiBinding(env) !== null,
    ...(off && { workersAiOff: WORKERS_AI_OFF_REASON }),
  };
}

/** The providers over this Worker's key and binding. A factory throws when its side is unavailable (`unavailableReason` is checked first). */
export function providerFactories(
  env: ModelEnv,
  config: SiteConfig
): ProviderFactories {
  return {
    anthropic: (newHydrate) => {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is not set on this environment.");
      }
      return anthropicProvider(
        agentClient(env.ANTHROPIC_API_KEY),
        newHydrate(),
        config
      );
    },
    workersAi: (model, newHydrate) => {
      const ai = workersAiBinding(env);
      if (!ai) {
        throw new Error("This Worker has no AI binding.");
      }
      return workersAiProvider(ai, model, newHydrate, config);
    },
  };
}

/** `TurnDeps.provider`: the provider for a thread's model, with a fresh image hydrator over R2 per call. */
export function modelProviders(
  env: ModelEnv,
  blobs: ImageBlobs,
  config: SiteConfig
): (model: ModelRef) => ModelProvider {
  const factories = providerFactories(env, config);
  return (model) => providerFor(factories, model, () => hydrator(blobs));
}
