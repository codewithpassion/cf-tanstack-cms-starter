CREATE TABLE `agent_budget_overrides` (
	`amount_usd` real,
	`created_at` integer NOT NULL,
	`created_by` text,
	`day` text,
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`thread_id` text
);
--> statement-breakpoint
CREATE INDEX `agent_budget_overrides_thread_idx` ON `agent_budget_overrides` (`thread_id`);--> statement-breakpoint
CREATE INDEX `agent_budget_overrides_day_idx` ON `agent_budget_overrides` (`day`);--> statement-breakpoint
CREATE TABLE `agent_changesets` (
	`base_doc` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decision` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`page_id` text NOT NULL,
	`payload` text NOT NULL,
	`proposed_doc` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`thread_id` text NOT NULL,
	`warnings` text,
	FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_changesets_thread_idx` ON `agent_changesets` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`content` text NOT NULL,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`model` text,
	`role` text NOT NULL,
	`seq` integer NOT NULL,
	`stop_reason` text,
	`thread_id` text NOT NULL,
	`usage` text,
	FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_thread_seq_unique` ON `agent_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `agent_messages_created_at_idx` ON `agent_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`approved_at` integer,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`items` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`reverted_at` integer,
	`reverted_by` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`thread_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_runs_thread_idx` ON `agent_runs` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_updated_at_idx` ON `agent_runs` (`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`daily_cap_usd` real,
	`id` text PRIMARY KEY NOT NULL,
	`models` text,
	`thread_cap_usd` real,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `agent_threads` (
	`author` text,
	`created_at` integer NOT NULL,
	`decisions_reported_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`lock_at` integer,
	`lock_expires_at` integer,
	`lock_id` text,
	`model` text DEFAULT 'claude-opus-5-5' NOT NULL,
	`page_id` text NOT NULL,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`scope` text DEFAULT 'page' NOT NULL,
	`stop_requested` text,
	`title` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_threads_page_id_updated_at_idx` ON `agent_threads` (`page_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_usage` (
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`model` text,
	`thread_id` text NOT NULL,
	`usage` text
);
--> statement-breakpoint
CREATE INDEX `agent_usage_thread_idx` ON `agent_usage` (`thread_id`);--> statement-breakpoint
CREATE INDEX `agent_usage_created_at_idx` ON `agent_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`created_at` integer NOT NULL,
	`created_by` text,
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`scope` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `gsc_inspections` (
	`checked_at` integer NOT NULL,
	`coverage_state` text,
	`google_canonical` text,
	`last_crawl` text,
	`page` text NOT NULL,
	`raw_json` text,
	`user_canonical` text,
	`verdict` text NOT NULL,
	PRIMARY KEY(`page`, `checked_at`)
);
--> statement-breakpoint
CREATE TABLE `gsc_page_days` (
	`clicks` integer NOT NULL,
	`ctr` real NOT NULL,
	`date` text NOT NULL,
	`impressions` integer NOT NULL,
	`page` text NOT NULL,
	`position` real NOT NULL,
	PRIMARY KEY(`date`, `page`)
);
--> statement-breakpoint
CREATE INDEX `gsc_page_days_page_date_idx` ON `gsc_page_days` (`page`,`date`);--> statement-breakpoint
CREATE TABLE `gsc_rows` (
	`clicks` integer NOT NULL,
	`ctr` real NOT NULL,
	`date` text NOT NULL,
	`device` text NOT NULL,
	`impressions` integer NOT NULL,
	`page` text NOT NULL,
	`position` real NOT NULL,
	`query` text NOT NULL,
	PRIMARY KEY(`date`, `page`, `query`, `device`)
);
--> statement-breakpoint
CREATE INDEX `gsc_rows_page_date_idx` ON `gsc_rows` (`page`,`date`);--> statement-breakpoint
CREATE TABLE `mcp_calls` (
	`at` integer NOT NULL,
	`connection_id` text,
	`error_code` text,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_id` text,
	`ok` integer NOT NULL,
	`target` text,
	`tool` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `oauth_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_calls_key_at_idx` ON `mcp_calls` (`key_id`,`at`);--> statement-breakpoint
CREATE INDEX `mcp_calls_connection_at_idx` ON `mcp_calls` (`connection_id`,`at`);--> statement-breakpoint
CREATE INDEX `mcp_calls_at_idx` ON `mcp_calls` (`at`);--> statement-breakpoint
CREATE TABLE `media` (
	`alt` text,
	`created_at` integer NOT NULL,
	`height` integer,
	`id` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`source` text NOT NULL,
	`tags` text,
	`width` integer
);
--> statement-breakpoint
CREATE INDEX `media_sha256_idx` ON `media` (`sha256`);--> statement-breakpoint
CREATE TABLE `oauth_connections` (
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`email` text NOT NULL,
	`grant_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`revoked_at` integer,
	`scope` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_connections_client_idx` ON `oauth_connections` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `pages` (
	`draft_base_rev_id` text,
	`draft_doc` text,
	`draft_version` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_batch_id` text,
	`live_rev_id` text,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_slug_unique` ON `pages` (`slug`) WHERE status != 'archived';--> statement-breakpoint
CREATE TABLE `revision_labels` (
	`label` text,
	`pinned` integer DEFAULT false NOT NULL,
	`rev_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`rev_id`) REFERENCES `revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`agent_run_id` text,
	`author` text,
	`created_at` integer NOT NULL,
	`doc_json` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`page_id` text NOT NULL,
	`parent_rev_id` text,
	`summary` text,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `revisions_page_id_created_at_idx` ON `revisions` (`page_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `site` (
	`draft_base_rev_id` text,
	`draft_doc` text NOT NULL,
	`draft_version` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_batch_id` text,
	`live_rev_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_revisions` (
	`author` text,
	`created_at` integer NOT NULL,
	`doc_json` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`parent_rev_id` text,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `site_revisions_created_at_idx` ON `site_revisions` (`created_at`);