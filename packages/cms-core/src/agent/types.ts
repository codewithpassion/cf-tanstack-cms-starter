import type { Device, Op, PageSeo } from "../types";
import type { BudgetStatus } from "./budget-types";
import type { AgentProviderId } from "./models";
import type { Run } from "./run";

/**
 * Types shared by the agent route, its server functions and the editor's AI tab.
 * Types only: safe for the client bundle.
 */

/** Stable error codes the tools return to the model (§4.3), plus the agent's own limits. */
export type AgentErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PROPS"
  | "INVALID_STYLE"
  | "INVALID_OPS"
  | "INVALID_SEO"
  | "UNKNOWN_BLOCK"
  | "UNKNOWN_KEY"
  | "BAD_POSITION"
  | "DUPLICATE_KEY"
  | "NOT_FOUND"
  | "WRONG_PAGE"
  | "NOT_ALLOWED"
  | "LIMIT_REACHED"
  | "RENDER_FAILED"
  | "NO_DATA"
  | "INVALID_SLUG"
  | "SLUG_TAKEN"
  | "SLUG_RESERVED";

export type AgentToolError = {
  code: AgentErrorCode;
  message: string;
  path?: string;
};

/** Non-blocking: the agent may keep a change that triggers one if it explains why. */
export type AgentWarning = {
  code: "LOW_CONTRAST";
  key: string;
  message: string;
};

/** What the user asked about: sent with every message, shown to the model as a mid-conversation system message. */
export type AgentContext = {
  device: Device;
  selectedKey: string | null;
  /** The draft version the editor holds (it saves before sending). */
  draftVersion: number;
};

// ---------------------------------------------------------------------------------------------
// Changesets

export type ChangesetStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "partial"
  | "superseded";

/** SEO fields `propose_seo` may set (never the slug: changing it is a redirect, which the agent can't do). */
export type SeoProposalPatch = {
  focusKeyphrase?: string;
  title?: string;
  titleExact?: boolean;
  description?: string;
  social?: {
    title?: string;
    description?: string;
    image?: NonNullable<PageSeo["social"]["image"]>;
  };
  schema?: {
    pageType?: PageSeo["schema"]["pageType"];
    breadcrumbLabel?: string;
  };
  llms?: { include?: boolean; summary?: string };
};

export type SeoVariant = { title: string; description: string; note?: string };

export type SeoProposal = {
  seo: SeoProposalPatch;
  /** 2–3 title/description pairs; the user picks one. */
  variants: SeoVariant[];
  /** Why this keyphrase: the Search Console queries it came from. */
  rationale?: string;
};

export type Changeset = {
  id: string;
  threadId: string;
  pageId: string;
  kind: "ops" | "seo";
  summary: string;
  status: ChangesetStatus;
  createdAt: string;
  /** `ops`: the staged ops (already in the editor's format: rich text as JSON, keys filled in). */
  ops?: Op[];
  /** `ops`: the draft the ops were staged against, as JSON text (for conflict checks). */
  baseDocJson?: string;
  /** `seo` */
  seo?: SeoProposal;
  warnings?: AgentWarning[];
  /** What the user decided, per group (block key, "seo" or "post"). */
  decision?: {
    accepted: string[];
    rejected: string[];
    variant?: number;
    revId?: string | null;
  };
};

// ---------------------------------------------------------------------------------------------
// Streaming events (SSE `data:` lines, one JSON object each)

export type ToolActivity = { id: string; name: string; label: string };

export type UsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/** A draft the agent created with `create_page` (never published). */
export type CreatedPage = {
  id: string;
  kind: "page" | "post";
  slug: string;
  title: string;
  editorUrl: string;
};

/** Why a thread takes no new messages, and a summary to start the next one with. */
export type ThreadFull = {
  reason: "turns" | "images" | "context";
  message: string;
  summary: string;
};

/**
 * The thread's model is turned off or removed in AI settings: the thread takes no new messages.
 * `next` is the model to start a new thread with (null when none is enabled and available).
 */
export type ModelOff = {
  message: string;
  summary: string;
  next: { provider: AgentProviderId; id: string; label: string } | null;
};

export type AgentEvent =
  | {
      type: "thread";
      threadId: string;
      title: string;
      provider: AgentProviderId;
      model: string;
    }
  /** The new thread was removed again: its first turn stored nothing (stopped or failed). */
  | { type: "thread_gone" }
  /** A model call starts: what follows until the next one belongs to it. */
  | { type: "call_start" }
  /** The current model call is being retried: discard what it has shown so far. */
  | { type: "reset" }
  | { type: "text"; text: string }
  /** A progress note between tool calls (`thinking.display: "updates"`), or (`reasoning`) a model's reasoning text, shown collapsed. */
  | { type: "progress"; text: string; reasoning?: true }
  | { type: "tool_start"; tool: ToolActivity }
  | {
      type: "tool_end";
      id: string;
      ok: boolean;
      summary: string;
      image?: string;
    }
  | { type: "changeset"; changeset: Changeset }
  | { type: "fallback"; from: string; to: string }
  | { type: "refusal"; category: string | null; explanation: string | null }
  | { type: "usage"; usage: UsageSummary; threadCostUsd: number }
  /** The spending caps after a call, or (with `blocked`) why the turn paused. */
  | { type: "budget"; budget: BudgetStatus }
  | { type: "created"; page: CreatedPage }
  /** `submit_plan` proposed a run (site-wide conversations). */
  | { type: "plan"; run: Run }
  /** A run item started or finished. */
  | { type: "run"; run: Run }
  | { type: "notice"; text: string }
  | { type: "error"; message: string }
  /**
   * `stopReason` is the model's, or "aborted" (Stop during a model call: its output is dropped),
   * "stopped" (Stop between calls), "budget" (a cap was reached), "detached" (the tab went away) or "error".
   */
  | { type: "done"; stopReason: string | null };

// ---------------------------------------------------------------------------------------------
// Threads as the AI tab shows them

export type ThreadSummary = {
  id: string;
  pageId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  costUsd: number;
  /** The model the thread talks to (fixed when it starts). */
  provider: AgentProviderId;
  model: string;
};

/** One rendered item of a thread's transcript. */
export type ThreadItem =
  | { kind: "user"; id: string; text: string; images: string[] }
  /** `partial`: cut off (a refusal or the output limit ended the reply). */
  | {
      kind: "text";
      id: string;
      text: string;
      model?: string;
      fallback?: boolean;
      partial?: boolean;
    }
  | { kind: "progress"; id: string; text: string; reasoning?: boolean }
  /** `interrupted`: the call never got a result (Stop, or the request ended). */
  | {
      kind: "tool";
      id: string;
      name: string;
      label: string;
      ok: boolean | null;
      summary?: string;
      image?: string;
      interrupted?: boolean;
    }
  | { kind: "refusal"; id: string; category: string | null }
  | { kind: "created"; id: string; page: CreatedPage }
  | { kind: "notice"; id: string; text: string };

export type ThreadDetail = {
  thread: ThreadSummary;
  items: ThreadItem[];
  changesets: Changeset[];
  usage: UsageSummary;
  budget: BudgetStatus;
  /** Set when the thread takes no new messages. */
  full: ThreadFull | null;
  /** Set when the thread's model is turned off or removed (it takes no new messages). */
  modelOff: ModelOff | null;
  /** The last turn paused on a spending cap: it can be continued after raising the limit. */
  canContinue: boolean;
};
