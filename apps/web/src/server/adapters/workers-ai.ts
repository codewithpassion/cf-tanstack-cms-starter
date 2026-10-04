import type { AiBinding } from "@repo/services/agent/workers-ai";

/**
 * The Workers AI side of the agent's providers (the provider itself, message conversion, retries
 * and streaming live in `@repo/services/agent/workers-ai`). This only hands over the `AI` binding
 * and says whether it can run.
 */

/** Why Workers AI can't run in this process even though the binding exists, or null. */
export const WORKERS_AI_OFF_REASON =
  "Workers AI runs remotely: this dev server was started with CF_REMOTE_BINDINGS=0. Restart it without that (after `wrangler login`).";

/**
 * True in a dev server started with CF_REMOTE_BINDINGS=0: the `AI` binding exists there but every
 * call fails, so vite.config.ts defines `__WORKERS_AI_OFF__`. Undefined under `bun test`.
 */
export function workersAiOff(): boolean {
  // biome-ignore lint/correctness/noUndeclaredVariables: a Vite define, declared in src/env.d.ts.
  return typeof __WORKERS_AI_OFF__ !== "undefined" && __WORKERS_AI_OFF__;
}

/** The `AI` binding as the provider's port, or null when the Worker has none. */
export function workersAiBinding(env: { AI?: unknown }): AiBinding | null {
  const ai = env.AI as Partial<AiBinding> | undefined;
  return ai && typeof ai.run === "function" ? (ai as AiBinding) : null;
}
