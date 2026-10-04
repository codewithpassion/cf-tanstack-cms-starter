import {
  type AgentModel,
  type AgentModelOption,
  DEFAULT_AGENT_MODELS,
  type ModelRef,
} from "@repo/cms-core/agent/models";
import type { Hydrate } from "./anthropic";
import type { ModelProvider } from "./provider";
import type { AgentStore } from "./store-port";

/**
 * Which agent models can run on this deployment, and the provider for a thread's model. Pure: the
 * web adapter reads the environment (the Anthropic key, the Workers AI binding, the dev-server
 * switch that turns Workers AI off) into `ProviderAvailability` and builds the concrete providers
 * into `ProviderFactories`.
 */

/** What the environment offers. `workersAiOff`: why Workers AI can't run even though it is bound (set, with a reason, when it can't). */
export type ProviderAvailability = {
  anthropic: boolean;
  workersAi: boolean;
  workersAiOff?: string;
};

/** Builds a provider for a thread's model. `newHydrate` makes an image hydrator (Workers AI: one per request). */
export type ProviderFactories = {
  anthropic: (newHydrate: () => Hydrate) => ModelProvider;
  workersAi: (model: string, newHydrate: () => Hydrate) => ModelProvider;
};

/** Why the model can't run here, or null. */
export function unavailableReason(
  availability: ProviderAvailability,
  ref: Pick<ModelRef, "provider">
): string | null {
  if (ref.provider === "anthropic") {
    return availability.anthropic
      ? null
      : "ANTHROPIC_API_KEY is not set on this environment.";
  }
  if (availability.workersAiOff) {
    return availability.workersAiOff;
  }
  return availability.workersAi ? null : "This Worker has no AI binding.";
}

/** The configured models (or the built-in list) with their availability. */
export async function modelOptions(
  availability: ProviderAvailability,
  store: Pick<AgentStore, "getModels">
): Promise<AgentModelOption[]> {
  const models: AgentModel[] =
    (await store.getModels()) ?? DEFAULT_AGENT_MODELS;
  return models.map((m) => {
    const reason = unavailableReason(availability, m);
    return { ...m, available: !reason, ...(reason && { reason }) };
  });
}

/** The provider that runs a thread's model. */
export function providerFor(
  factories: ProviderFactories,
  ref: ModelRef,
  newHydrate: () => Hydrate
): ModelProvider {
  return ref.provider === "workers-ai"
    ? factories.workersAi(ref.id, newHydrate)
    : factories.anthropic(newHydrate);
}
