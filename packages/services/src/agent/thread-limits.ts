import {
  MAX_THREAD_CONTEXT_TOKENS,
  MAX_THREAD_IMAGES,
  MAX_THREAD_TURNS,
} from "@repo/cms-core/agent/limits";
import type { Changeset, ThreadFull } from "@repo/cms-core/agent/types";
import type { StoredMessage } from "./store-port";
import {
  assistantTexts,
  contextTokensOf,
  countImages,
  isToolResults,
  isUserTurn,
} from "./transcript";

/**
 * Thread size limits (docs/cms-plan.md §4.2): the transcript is append-only and replayed in full
 * on every request (images included), so instead of trimming history a thread that grows past a
 * limit takes no new messages, and the AI tab offers "Start a new thread" with a short summary of
 * this one to carry over. Pure.
 */

// biome-ignore lint/performance/noBarrelFile: the turn predicates travel with the limits that use them, as in the source.
export { isToolResults, isUserTurn } from "./transcript";

/** A turn that paused on a spending cap ends with tool results: the model is due to answer them. */
export function canContinue(history: StoredMessage[]): boolean {
  const last = history.at(-1);
  return !!last && isToolResults(last);
}

export type ThreadStats = {
  turns: number;
  images: number;
  contextTokens: number;
};

export function threadStats(messages: StoredMessage[]): ThreadStats {
  const last = messages.filter((m) => m.role === "assistant" && m.usage).at(-1);
  return {
    turns: messages.filter(isUserTurn).length,
    images: messages.reduce(
      (s, m) => s + (m.role === "system" ? 0 : countImages(m.content)),
      0
    ),
    // The latest request's input plus its reply, which the next request also sends.
    contextTokens: contextTokensOf(last?.usage),
  };
}

/** Why the thread takes no new messages, or null. */
export function threadFullReason(
  stats: ThreadStats
): ThreadFull["reason"] | null {
  if (stats.turns >= MAX_THREAD_TURNS) {
    return "turns";
  }
  if (stats.images >= MAX_THREAD_IMAGES) {
    return "images";
  }
  if (stats.contextTokens >= MAX_THREAD_CONTEXT_TOKENS) {
    return "context";
  }
  return null;
}

const REASON_TEXT: Record<ThreadFull["reason"], string> = {
  turns: `This conversation has reached ${MAX_THREAD_TURNS} messages.`,
  images: `This conversation holds ${MAX_THREAD_IMAGES} images, which are re-sent with every message.`,
  context: "This conversation is too long to send again.",
};

const SUMMARY_MAX = 700;

/** A short summary to start the next thread with: what was asked, proposed and decided, and the last reply. */
export function continueSummary(
  title: string,
  messages: StoredMessage[],
  changesets: Changeset[]
): string {
  const lines = [`Continuing from the conversation "${title}".`];
  const decided = changesets.filter((c) => c.status !== "superseded").slice(-6);
  if (decided.length) {
    lines.push(
      `Proposals: ${decided.map((c) => `"${c.summary.slice(0, 80)}" (${c.status})`).join("; ")}.`
    );
  }
  const lastText = messages
    .flatMap(assistantTexts)
    .map((t) => t.trim())
    .at(-1);
  if (lastText) {
    lines.push(
      `Your last reply: ${lastText.replace(/\s+/g, " ").slice(0, 300)}`
    );
  }
  return lines.join("\n").slice(0, SUMMARY_MAX);
}

export function threadFull(
  title: string,
  messages: StoredMessage[],
  changesets: Changeset[]
): ThreadFull | null {
  const reason = threadFullReason(threadStats(messages));
  if (!reason) {
    return null;
  }
  return {
    reason,
    message: `${REASON_TEXT[reason]} Start a new thread to keep going.`,
    summary: continueSummary(title, messages, changesets),
  };
}
