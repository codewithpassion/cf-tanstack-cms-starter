// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
import type { ModelOff } from "./types";

/**
 * The models the page agent can talk to (AI settings on /admin/setup, "Agent models"). A thread
 * picks one when it starts and keeps it: its transcript is stored in that provider's format.
 * Client-safe (types, defaults and validation only).
 */

export type AgentProviderId = "anthropic" | "workers-ai";

export type AgentModel = {
  provider: AgentProviderId;
  /** `claude-opus-5-5`, or a Workers AI text-generation model id (`@cf/<org>/<name>`). */
  id: string;
  label: string;
  enabled: boolean;
};

/** A model as the AI tab offers it: whether it can run here, and why not. */
export type AgentModelOption = AgentModel & {
  available: boolean;
  reason?: string;
};

export type ModelRef = { provider: AgentProviderId; id: string };

export const ANTHROPIC_MODEL_ID = "claude-opus-5-5";
export const GLM_FLASH_MODEL_ID = "@cf/zai-org/glm-5.3-flash";

/** What a thread uses when none is chosen, and what threads created before the choice existed use. */
export const DEFAULT_MODEL: ModelRef = {
  provider: "anthropic",
  id: ANTHROPIC_MODEL_ID,
};

export const DEFAULT_AGENT_MODELS: AgentModel[] = [
  {
    provider: "anthropic",
    id: ANTHROPIC_MODEL_ID,
    label: "Claude Opus 5.5",
    enabled: true,
  },
  {
    provider: "workers-ai",
    id: GLM_FLASH_MODEL_ID,
    label: "GLM-5.3 Flash",
    enabled: true,
  },
];

export const PROVIDER_LABEL: Record<AgentProviderId, string> = {
  anthropic: "Anthropic",
  "workers-ai": "Workers AI",
};

/** Workers AI text-generation model ids: `@cf/<org>/<name>`. */
export const WORKERS_AI_MODEL_ID =
  /^@cf\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i;

const MAX_MODELS = 20;
const MAX_LABEL = 60;

/**
 * Checks an edited model list: known providers, the one supported Anthropic model, Workers AI
 * ids in the `@cf/…` form (the model must support function calling; that can't be checked here),
 * labels, no duplicates, at least one enabled.
 */
export function validateModels(
  input: unknown
): { ok: true; models: AgentModel[] } | { ok: false; message: string } {
  if (!(Array.isArray(input) && input.length) || input.length > MAX_MODELS) {
    return { ok: false, message: `Expected 1 to ${MAX_MODELS} models.` };
  }
  const models: AgentModel[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const at = `Model ${i + 1}`;
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: `${at}: expected an object.` };
    }
    const m = raw as Record<string, unknown>;
    if (m.provider !== "anthropic" && m.provider !== "workers-ai") {
      return { ok: false, message: `${at}: unknown provider.` };
    }
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (m.provider === "anthropic" && id !== ANTHROPIC_MODEL_ID) {
      return {
        ok: false,
        message: `${at}: the only Anthropic model is ${ANTHROPIC_MODEL_ID}.`,
      };
    }
    if (m.provider === "workers-ai" && !WORKERS_AI_MODEL_ID.test(id)) {
      return {
        ok: false,
        message: `${at}: a Workers AI model id looks like @cf/<org>/<model>, e.g. ${GLM_FLASH_MODEL_ID}.`,
      };
    }
    const label = typeof m.label === "string" ? m.label.trim() : "";
    if (!label || label.length > MAX_LABEL) {
      return {
        ok: false,
        message: `${at}: a label of 1 to ${MAX_LABEL} characters is needed.`,
      };
    }
    if (typeof m.enabled !== "boolean") {
      return {
        ok: false,
        message: `${at}: expected enabled to be true or false.`,
      };
    }
    const key = `${m.provider}:${id}`;
    if (seen.has(key)) {
      return { ok: false, message: `${at}: ${id} is listed twice.` };
    }
    seen.add(key);
    models.push({ provider: m.provider, id, label, enabled: m.enabled });
  }
  if (!models.some((m) => m.enabled)) {
    return { ok: false, message: "Enable at least one model." };
  }
  return { ok: true, models };
}

/** The label of a thread's model from the list, or its id. */
export function modelLabel(
  models: readonly AgentModel[],
  ref: ModelRef
): string {
  return (
    models.find((m) => m.provider === ref.provider && m.id === ref.id)?.label ??
    ref.id
  );
}

/**
 * When a thread's model is turned off or removed in AI settings, the thread takes no new messages
 * (its transcript is in that model's format): what to tell the user, and the model to start a new
 * thread with (the default when it can run, else the first model that can). Null while the model
 * is enabled.
 */
export function modelOffInfo(
  options: readonly AgentModelOption[],
  ref: ModelRef
): { message: string; next: ModelOff["next"] } | null {
  const option = options.find(
    (m) => m.provider === ref.provider && m.id === ref.id
  );
  if (option?.enabled) {
    return null;
  }
  const usable = options.filter((m) => m.enabled && m.available);
  const pick =
    usable.find(
      (m) => m.provider === DEFAULT_MODEL.provider && m.id === DEFAULT_MODEL.id
    ) ?? usable[0];
  const name = option?.label ?? ref.id;
  const why = option
    ? `${name} is turned off in AI settings`
    : `${name} is no longer in AI settings`;
  return pick
    ? {
        message: `${why}, so this conversation can't continue. Start a new thread with ${pick.label} to keep going.`,
        next: { provider: pick.provider, id: pick.id, label: pick.label },
      }
    : {
        message: `${why}, so this conversation can't continue, and no other model is available. Enable one in AI settings.`,
        next: null,
      };
}
