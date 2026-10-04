import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { PageDoc, SiteDoc } from "./shared.ts";

// The tables. `drizzle-kit generate` diffs this file against the last snapshot
// in migrations/, so every change here needs a new migration generated with it.

/**
 * Any drizzle SQLite instance, sync or async. D1 (`drizzle-orm/d1`) is async and
 * `bun:sqlite` (`drizzle-orm/bun-sqlite`) is sync; both satisfy this, and awaiting
 * works either way. Modules that only run, say, a single query take this.
 */
export type Database = BaseSQLiteDatabase<"sync" | "async", unknown>;

/**
 * A D1 drizzle instance: `drizzle(env.DB, { schema })` from `drizzle-orm/d1`. The table
 * modules that commit with `db.batch` (D1 has no interactive transactions) take this, since
 * `batch` only exists on the D1 driver. Tests build one over a `bun:sqlite` stand-in
 * (`src/test-utils.ts`).
 */
export type D1Db = DrizzleD1Database<typeof import("./schema.ts")>;

/**
 * CMS schema. Ids are text, timestamps are integer milliseconds since the epoch, JSON columns
 * are text with Drizzle's json mode. Page and site documents are typed `PageDoc` and `SiteDoc`
 * (src/shared.ts); the page service validates them before every write.
 *
 * `draft_base_rev_id` and `live_rev_id` point at `revisions.id` but carry no foreign key:
 * `revisions.page_id` already references `pages.id`, and the reverse key would make the
 * two tables circular.
 */

export const pages = sqliteTable(
  "pages",
  {
    draftBaseRevId: text("draft_base_rev_id"),
    draftDoc: text("draft_doc", { mode: "json" }).$type<PageDoc>(),
    // Optimistic concurrency for draft saves: each save must name the version it was based on.
    draftVersion: integer("draft_version").notNull().default(0),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["page", "post"] }).notNull(),
    // Idempotency key of the last applied editor save batch: a retried batch whose response was
    // lost is acknowledged instead of failing as STALE_DRAFT.
    lastBatchId: text("last_batch_id"),
    liveRevId: text("live_rev_id"),
    // Path-like, e.g. `services/automation-sprint` or `blog/my-post`.
    slug: text("slug").notNull(),
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
    title: text("title").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  // Archived pages free their slug.
  (t) => [
    uniqueIndex("pages_slug_unique")
      .on(t.slug)
      .where(sql`status != 'archived'`),
  ]
);

/** Append-only: rows are never updated or deleted. */
export const revisions = sqliteTable(
  "revisions",
  {
    agentRunId: text("agent_run_id"),
    author: text("author"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    docJson: text("doc_json", { mode: "json" }).$type<PageDoc>().notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["autosnapshot", "named", "published", "agent", "restore"],
    }).notNull(),
    label: text("label"),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id),
    parentRevId: text("parent_rev_id"),
    summary: text("summary"),
  },
  (t) => [index("revisions_page_id_created_at_idx").on(t.pageId, t.createdAt)]
);

/**
 * Rename and pin for revisions, kept apart so `revisions` stays append-only: a row here overrides
 * the revision's display label (null keeps the original) and pins it to the top of the history.
 */
export const revisionLabels = sqliteTable("revision_labels", {
  label: text("label"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  revId: text("rev_id")
    .primaryKey()
    .references(() => revisions.id),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const media = sqliteTable(
  "media",
  {
    alt: text("alt"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    height: integer("height"),
    id: text("id").primaryKey(),
    mime: text("mime").notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    /** `agent`: a share image the AI agent rendered (hidden from the library grid unless asked for). */
    source: text("source", {
      enum: ["upload", "share-image", "flux", "agent"],
    }).notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    width: integer("width"),
  },
  (t) => [index("media_sha256_idx").on(t.sha256)]
);

/**
 * The site settings document : one row, id "site", with the same
 * draft/live model as `pages`. Kept out of `pages` so it can never show up in page lists, the
 * sitemap, llms.txt, the SEO overview or slug checks.
 */
export const site = sqliteTable("site", {
  draftBaseRevId: text("draft_base_rev_id"),
  draftDoc: text("draft_doc", { mode: "json" }).$type<SiteDoc>().notNull(),
  draftVersion: integer("draft_version").notNull().default(0),
  id: text("id").primaryKey(),
  /** The last save's idempotency key (`batchId` of the site draft save). */
  lastBatchId: text("last_batch_id"),
  liveRevId: text("live_rev_id"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Append-only history of the site doc, like `revisions`. */
export const siteRevisions = sqliteTable(
  "site_revisions",
  {
    author: text("author"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    docJson: text("doc_json", { mode: "json" }).$type<SiteDoc>().notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["autosnapshot", "named", "published", "restore"],
    }).notNull(),
    label: text("label"),
    parentRevId: text("parent_rev_id"),
    summary: text("summary"),
  },
  (t) => [index("site_revisions_created_at_idx").on(t.createdAt)]
);

/**
 * Google Search Console data filled by the daily cron and the one-off
 * backfill. `date` is the API's YYYY-MM-DD (Pacific
 * time, as in the GSC UI); `page` is the full URL Google reports, e.g. https://example.com/about.
 * `ctr` is a fraction (0–1), `position` the average position (1 = top).
 */
export const gscRows = sqliteTable(
  "gsc_rows",
  {
    clicks: integer("clicks").notNull(),
    ctr: real("ctr").notNull(),
    date: text("date").notNull(),
    device: text("device").notNull(),
    impressions: integer("impressions").notNull(),
    page: text("page").notNull(),
    position: real("position").notNull(),
    query: text("query").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.page, t.query, t.device] }),
    index("gsc_rows_page_date_idx").on(t.page, t.date),
  ]
);

/**
 * Page totals per day, pulled without the query dimension: anonymised queries are left out of
 * `gsc_rows`, so its rows never add up to these.
 */
export const gscPageDays = sqliteTable(
  "gsc_page_days",
  {
    clicks: integer("clicks").notNull(),
    ctr: real("ctr").notNull(),
    date: text("date").notNull(),
    impressions: integer("impressions").notNull(),
    page: text("page").notNull(),
    position: real("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.page] }),
    index("gsc_page_days_page_date_idx").on(t.page, t.date),
  ]
);

/** URL Inspection results, one row per check (the latest per page is the current state). */
export const gscInspections = sqliteTable(
  "gsc_inspections",
  {
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
    coverageState: text("coverage_state"),
    googleCanonical: text("google_canonical"),
    /** RFC 3339, as Google reports it. */
    lastCrawl: text("last_crawl"),
    page: text("page").notNull(),
    /** The API's `indexStatusResult`. */
    rawJson: text("raw_json"),
    userCanonical: text("user_canonical"),
    /** PASS, PARTIAL, FAIL, NEUTRAL or VERDICT_UNSPECIFIED. */
    verdict: text("verdict").notNull(),
  },
  (t) => [primaryKey({ columns: [t.page, t.checkedAt] })]
);

/**
 * AI page agent: one thread per task, on one page. `agent_messages` is the
 * append-only transcript sent back to the model on every request (Claude Opus 5.5 ties thinking
 * blocks to the exact conversation, so rows are never updated or deleted). `content` is the API
 * message content as JSON; user images are stored as media references and expanded on replay.
 * `usage` and `cost_usd` are set on assistant rows (cost in USD, all attempts of that response).
 */
export const agentThreads = sqliteTable(
  "agent_threads",
  {
    author: text("author"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Decisions on proposals made up to here were reported to the model (in a user message). */
    decisionsReportedAt: integer("decisions_reported_at", {
      mode: "timestamp_ms",
    }),
    id: text("id").primaryKey(),
    lockAt: integer("lock_at", { mode: "timestamp_ms" }),
    lockExpiresAt: integer("lock_expires_at", { mode: "timestamp_ms" }),
    /** The running turn's lock (one turn per thread at a time): its id, when it was taken, and its lease (renewed while running). */
    lockId: text("lock_id"),
    model: text("model").notNull().default("claude-opus-5-5"),
    pageId: text("page_id").notNull(),
    /**
     * The model the thread talks to, chosen when it starts and fixed for its life: `anthropic`
     * (transcript in Anthropic blocks) or `workers-ai` (OpenAI-style messages with a `tool` role).
     */
    provider: text("provider", { enum: ["anthropic", "workers-ai"] })
      .notNull()
      .default("anthropic"),
    /**
     * `page`: a conversation about `page_id`. `site`: a site-wide conversation that plans and runs
     * multi-page runs (`agent_runs`); `page_id` is the page it was started from. `item`: the
     * transcript of one run item (id `<run id>~<n>`), kept apart from the
     * site thread so item turns don't pile up in it; not listed in the AI tab.
     */
    scope: text("scope", { enum: ["page", "site", "item"] })
      .notNull()
      .default("page"),
    /** Set to the running turn's lock id by Stop; the turn polls it and aborts its model call. */
    stopRequested: text("stop_requested"),
    title: text("title").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("agent_threads_page_id_updated_at_idx").on(t.pageId, t.updatedAt),
  ]
);

/**
 * Site-wide agent runs: a plan the agent submitted in a
 * site thread (`proposed`), which the user edits and approves (`active`); the client then runs
 * one item (page) per request. `items` holds each item's intent and progress , including the changesets it staged, the drafts it created and the
 * `agent` revisions its accepted changes became ("Revert this run" restores from those).
 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    /** Spend of the planning turn and every item turn, in USD. */
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    items: text("items", { mode: "json" }).notNull(),
    model: text("model").notNull(),
    provider: text("provider", { enum: ["anthropic", "workers-ai"] }).notNull(),
    revertedAt: integer("reverted_at", { mode: "timestamp_ms" }),
    revertedBy: text("reverted_by"),
    status: text("status", {
      enum: [
        "proposed",
        "superseded",
        "discarded",
        "active",
        "done",
        "cancelled",
      ],
    }).notNull(),
    /** The plan's one-line summary, written by the agent. */
    summary: text("summary").notNull(),
    threadId: text("thread_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** Bumped on every write: item updates from the running turn and from the review queue compare-and-set on it. */
    version: integer("version").notNull().default(0),
  },
  (t) => [
    index("agent_runs_thread_idx").on(t.threadId, t.createdAt),
    index("agent_runs_updated_at_idx").on(t.updatedAt),
  ]
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    content: text("content", { mode: "json" }).notNull(),
    costUsd: real("cost_usd"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    /** Assistant rows: the model that answered (a fallback model when one did). */
    model: text("model"),
    /** `tool`: a tool result in a `workers-ai` thread (Anthropic threads carry them in `user` rows). */
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    /** Order within the thread (0, 1, 2…). */
    seq: integer("seq").notNull(),
    stopReason: text("stop_reason"),
    threadId: text("thread_id")
      .notNull()
      .references(() => agentThreads.id),
    usage: text("usage", { mode: "json" }),
  },
  (t) => [
    uniqueIndex("agent_messages_thread_seq_unique").on(t.threadId, t.seq),
    index("agent_messages_created_at_idx").on(t.createdAt),
  ]
);

/** Proposals staged by the agent's write tools; `status` and `decision` change when the user reviews them. */
export const agentChangesets = sqliteTable(
  "agent_changesets",
  {
    /** The draft the proposal was staged against. */
    baseDoc: text("base_doc", { mode: "json" }).$type<PageDoc>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    decision: text("decision", { mode: "json" }),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["ops", "seo"] }).notNull(),
    pageId: text("page_id").notNull(),
    /** `ops`: the staged editor ops; `seo`: the SEO proposal. */
    payload: text("payload", { mode: "json" }).notNull(),
    /** The draft with the proposal applied (what render_preview shows). */
    proposedDoc: text("proposed_doc", { mode: "json" })
      .$type<PageDoc>()
      .notNull(),
    status: text("status", {
      enum: ["pending", "accepted", "rejected", "partial", "superseded"],
    }).notNull(),
    summary: text("summary").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => agentThreads.id),
    warnings: text("warnings", { mode: "json" }),
  },
  (t) => [index("agent_changesets_thread_idx").on(t.threadId, t.createdAt)]
);

/**
 * Spend that has no transcript row: model calls that were stopped, failed, or retried after
 * malformed tool input, and "Suggest alt text" calls (`alt-text`, under a fixed thread id). Counted
 * in the thread's and the day's cost, never sent to the model. `kind` is not constrained in SQL, so
 * a new kind needs no migration.
 */
export const agentUsage = sqliteTable(
  "agent_usage",
  {
    costUsd: real("cost_usd").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["aborted", "retry", "error", "streaming", "alt-text"],
    }).notNull(),
    model: text("model"),
    threadId: text("thread_id").notNull(),
    usage: text("usage", { mode: "json" }),
  },
  (t) => [
    index("agent_usage_thread_idx").on(t.threadId),
    index("agent_usage_created_at_idx").on(t.createdAt),
  ]
);

/**
 * AI settings (one row, id "default"): the default spending caps in USD (null = no cap; no row =
 * the built-in defaults) and the agent models offered for new threads (null = the built-in list).
 */
export const agentSettings = sqliteTable("agent_settings", {
  dailyCapUsd: real("daily_cap_usd"),
  id: text("id").primaryKey(),
  models: text("models", { mode: "json" }),
  threadCapUsd: real("thread_cap_usd"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  updatedBy: text("updated_by"),
});

/**
 * Raised limits: `thread` raises one thread's cap, `run` one site-wide run's cap (`thread_id`
 * holds the run id), `day` raises the cap for one day (Sydney date, YYYY-MM-DD). `amount_usd`
 * null = no limit for that thread, run or day.
 */
export const agentBudgetOverrides = sqliteTable(
  "agent_budget_overrides",
  {
    amountUsd: real("amount_usd"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    createdBy: text("created_by"),
    day: text("day"),
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["thread", "day", "run"] }).notNull(),
    threadId: text("thread_id"),
  },
  (t) => [
    index("agent_budget_overrides_thread_idx").on(t.threadId),
    index("agent_budget_overrides_day_idx").on(t.day),
  ]
);

/**
 * API keys for the CMS MCP server at `/mcp`. Only the SHA-256 of
 * a key is stored (hex, unique); `prefix` is what the admin sees ("cms_live_AbCd1234").
 * `scope`: `read` (read tools), `write` (also drafts, proposals, media, accept/reject), `full`
 * (also publish, unpublish, archive, rollback). Keys are revoked, never deleted, so the call log
 * keeps pointing at them. `created_by` is the admin's Clerk user id.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    createdBy: text("created_by"),
    id: text("id").primaryKey(),
    keyHash: text("key_hash").notNull(),
    /** Updated at most once a minute. */
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    scope: text("scope", { enum: ["read", "write", "full"] }).notNull(),
  },
  (t) => [uniqueIndex("api_keys_key_hash_unique").on(t.keyHash)]
);

/**
 * One row per OAuth grant to the MCP server: written when an
 * admin approves a client on /oauth/authorize, so the connection can be listed and revoked in
 * /admin/api-keys. The library's grant (OAUTH_KV) carries this row's id in its metadata and
 * props. `grant_id` is filled from the token on first use; `revoked_at` is set on Revoke and when
 * a new approval for the same client replaces this one.
 */
export const oauthConnections = sqliteTable(
  "oauth_connections",
  {
    /** A CIMD URL (e.g. Claude's) or a dynamically registered client id. */
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    email: text("email").notNull(),
    grantId: text("grant_id"),
    id: text("id").primaryKey(),
    /** Updated at most once a minute. */
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    /** `<client name> (<date>)`: the `mcp:<name>` author of its changes. */
    name: text("name").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    scope: text("scope", { enum: ["read", "write", "full"] }).notNull(),
    /** Clerk user id. */
    userId: text("user_id").notNull(),
  },
  (t) => [index("oauth_connections_client_idx").on(t.userId, t.clientId)]
);

/**
 * One row per MCP tool call: which key or OAuth connection (exactly one is set), which tool, the
 * page it targeted (id or slug) and whether it worked. Kept for 90 days; the daily cron deletes
 * older rows.
 */
export const mcpCalls = sqliteTable(
  "mcp_calls",
  {
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    connectionId: text("connection_id").references(() => oauthConnections.id),
    errorCode: text("error_code"),
    id: integer("id").primaryKey({ autoIncrement: true }),
    keyId: text("key_id").references(() => apiKeys.id),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    target: text("target"),
    tool: text("tool").notNull(),
  },
  (t) => [
    index("mcp_calls_key_at_idx").on(t.keyId, t.at),
    index("mcp_calls_connection_at_idx").on(t.connectionId, t.at),
    index("mcp_calls_at_idx").on(t.at),
  ]
);

export type PageRow = typeof pages.$inferSelect;
export type RevisionRow = typeof revisions.$inferSelect;
export type RevisionLabelRow = typeof revisionLabels.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type SiteRow = typeof site.$inferSelect;
export type SiteRevisionRow = typeof siteRevisions.$inferSelect;
export type GscRowRow = typeof gscRows.$inferSelect;
export type GscPageDayRow = typeof gscPageDays.$inferSelect;
export type GscInspectionRow = typeof gscInspections.$inferSelect;
export type AgentThreadRow = typeof agentThreads.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentMessageRow = typeof agentMessages.$inferSelect;
export type AgentChangesetRow = typeof agentChangesets.$inferSelect;
export type AgentUsageRow = typeof agentUsage.$inferSelect;
export type AgentSettingsRow = typeof agentSettings.$inferSelect;
export type AgentBudgetOverrideRow = typeof agentBudgetOverrides.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type OauthConnectionRow = typeof oauthConnections.$inferSelect;
export type McpCallRow = typeof mcpCalls.$inferSelect;
