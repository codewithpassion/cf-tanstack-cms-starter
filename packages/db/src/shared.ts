// Safe to import from browser code: no drizzle, no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull drizzle in.

export type { SiteDoc } from "@repo/cms-core/site/types";
// The stored documents are typed in `@repo/cms-core`. Type-only imports, so this file stays
// free of runtime code and safe for the browser.
export type { PageDoc } from "@repo/cms-core/types";

export const PAGE_KINDS = ["page", "post"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_STATUSES = ["draft", "published", "archived"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const REVISION_KINDS = [
  "autosnapshot",
  "named",
  "published",
  "agent",
  "restore",
] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const SITE_REVISION_KINDS = [
  "autosnapshot",
  "named",
  "published",
  "restore",
] as const;
export type SiteRevisionKind = (typeof SITE_REVISION_KINDS)[number];

export const MEDIA_SOURCES = [
  "upload",
  "share-image",
  "flux",
  "agent",
] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

/** The single `site` row's id. */
export const SITE_ID = "site";

/** `last_used_at` of a key or connection is written at most this often. */
export const LAST_USED_EVERY_MS = 60_000;

/** The daily cron deletes MCP calls older than this many days. */
export const CALL_RETENTION_DAYS = 90;

/** D1 binds at most 100 parameters per statement; a statement with `inArray` binds one per id. */
export const D1_MAX_PARAMS = 100;

export const AGENT_PROVIDERS = ["anthropic", "workers-ai"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_THREAD_SCOPES = ["page", "site", "item"] as const;
export type AgentThreadScope = (typeof AGENT_THREAD_SCOPES)[number];

export const AGENT_RUN_STATUSES = [
  "proposed",
  "superseded",
  "discarded",
  "active",
  "done",
  "cancelled",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_MESSAGE_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

export const AGENT_CHANGESET_KINDS = ["ops", "seo"] as const;
export type AgentChangesetKind = (typeof AGENT_CHANGESET_KINDS)[number];

export const AGENT_CHANGESET_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "partial",
  "superseded",
] as const;
export type AgentChangesetStatus = (typeof AGENT_CHANGESET_STATUSES)[number];

export const AGENT_USAGE_KINDS = [
  "aborted",
  "retry",
  "error",
  "streaming",
  "alt-text",
] as const;
export type AgentUsageKind = (typeof AGENT_USAGE_KINDS)[number];

export const AGENT_BUDGET_SCOPES = ["thread", "day", "run"] as const;
export type AgentBudgetScope = (typeof AGENT_BUDGET_SCOPES)[number];
