// Safe to import from browser code: no drizzle, no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull drizzle in.

// TODO(cms-port): PageDoc. The documents are typed in `@repo/cms-core` (`types.ts`, `site/types.ts`),
// which exports its modules separately and was still being written when this package was.
// Until the services phase swaps these two aliases for `import type { PageDoc } from
// "@repo/cms-core/types"` and `SiteDoc`, the stored documents are plain JSON objects here and
// callers cast on read. Any cms-core `PageDoc`/`SiteDoc` (a `type` alias) is assignable to them.
export type PageDoc = Record<string, unknown>;
export type SiteDoc = Record<string, unknown>;

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

/** MCP API key and OAuth connection scopes, weakest first. */
export const API_SCOPES = ["read", "write", "full"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

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
