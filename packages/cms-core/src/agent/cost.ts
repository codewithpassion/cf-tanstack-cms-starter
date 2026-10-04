// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
import type { UsageSummary } from "./types";

/**
 * Agent cost per message, for both providers. Claude Opus 5.5: $4 / $20 per
 * million input / output tokens, cache reads $0.20, 5-minute cache writes 1.25× input ($5).
 * Fallback attempts bill at the fallback model's rates, so their usage is priced with that model's
 * prices when known. Workers AI models: per-token prices from the pricing page; a Workers AI model
 * that isn't in the table is priced from the neurons its response reports.
 */

export const AGENT_MODEL = "claude-opus-5-5";

export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * USD per million tokens, checked 2026-10-02.
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - Workers AI: https://developers.cloudflare.com/workers-ai/platform/pricing/ ("cached input" is
 *   `cacheRead`; Workers AI has no cache-write charge).
 */
export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  "@cf/zai-org/glm-5.3-flash": {
    input: 0.15,
    output: 0.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
};

/** Workers AI bills in neurons: $0.011 per 1,000 (same pricing page). Used for models not in PRICES. */
export const WORKERS_AI_USD_PER_NEURON = 0.011 / 1000;

/** The usage fields we read (the SDK's `BetaUsage` has them, plus more). */
export type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Per-attempt usage when a fallback ran (`usage.iterations`); each entry is priced with its own model. */
export type RawIteration = RawUsage & { type?: string; model?: string | null };

export function costOf(usage: RawUsage, model: string = AGENT_MODEL): number {
  const p = PRICES[model] ?? PRICES[AGENT_MODEL]!;
  const n = (v: number | null | undefined) => v ?? 0;
  const usd =
    (n(usage.input_tokens) * p.input +
      n(usage.output_tokens) * p.output +
      n(usage.cache_read_input_tokens) * p.cacheRead +
      n(usage.cache_creation_input_tokens) * p.cacheWrite) /
    1_000_000;
  return round6(usd);
}

/**
 * One response's usage and cost. With `iterations` (a fallback ran), every attempt is billed, so
 * every attempt is summed; top-level usage then only covers the attempt that produced the message.
 * `model` is the model that answered; an iteration that doesn't name its model is priced as
 * `requestModel` (the model the request asked for, i.e. the one that declined).
 */
export function summarizeUsage(
  usage: RawUsage & { iterations?: RawIteration[] | null },
  model: string = AGENT_MODEL,
  requestModel: string = AGENT_MODEL
): UsageSummary {
  const parts: { u: RawUsage; model: string }[] = usage.iterations?.length
    ? usage.iterations.map((it) => ({ u: it, model: it.model ?? requestModel }))
    : [{ u: usage, model }];
  const sum = (k: keyof RawUsage) =>
    parts.reduce((s, p) => s + (p.u[k] ?? 0), 0);
  return {
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    cacheReadTokens: sum("cache_read_input_tokens"),
    cacheWriteTokens: sum("cache_creation_input_tokens"),
    costUsd: round6(parts.reduce((s, p) => s + costOf(p.u, p.model), 0)),
  };
}

/** Workers AI (OpenAI-style) usage as the binding reports it. `cached_tokens` is part of `prompt_tokens`. */
export type WorkersAiUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  /** Part of `completion_tokens`, when the model reports it. */
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  neurons?: number | null;
};

export const isWorkersAiUsage = (u: unknown): u is WorkersAiUsage =>
  typeof u === "object" && u !== null && "prompt_tokens" in u;

/** One Workers AI response's usage and cost: per-token prices when known, else its neurons. */
export function summarizeWorkersAiUsage(
  usage: WorkersAiUsage,
  model: string
): UsageSummary {
  const prompt = usage.prompt_tokens ?? 0;
  const cached = Math.min(
    prompt,
    usage.prompt_tokens_details?.cached_tokens ?? 0
  );
  const output = usage.completion_tokens ?? 0;
  const p = PRICES[model];
  const usd = p
    ? ((prompt - cached) * p.input + cached * p.cacheRead + output * p.output) /
      1_000_000
    : (usage.neurons ?? 0) * WORKERS_AI_USD_PER_NEURON;
  return {
    inputTokens: prompt - cached,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    costUsd: round6(usd),
  };
}

/** A stored assistant row's usage, whichever provider wrote it. */
export function usageSummaryOf(usage: unknown, model: string): UsageSummary {
  return isWorkersAiUsage(usage)
    ? summarizeWorkersAiUsage(usage, model)
    : summarizeUsage(usage as never, model);
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: round6(a.costUsd + b.costUsd),
  };
}

export const ZERO_USAGE: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

/** "$0.042", "$1.20", "<$0.001". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.001) {
    return "<$0.001";
  }
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
