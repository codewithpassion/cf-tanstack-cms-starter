// biome-ignore-all lint/style/useConsistentMethodSignatures: the port keeps the method signatures of its db twin (`AgentStoreTable`), so the two stay diffable.
import type { BudgetOverride } from "@repo/cms-core/agent/budget-types";
import type { AgentModel } from "@repo/cms-core/agent/models";
import type { Run } from "@repo/cms-core/agent/run";
import type {
  Changeset,
  ChangesetStatus,
  ThreadSummary,
} from "@repo/cms-core/agent/types";
import type {
  BudgetSettings,
  ChangesetRow,
  LockResult,
  PendingChangeset,
  StoredMessage,
  ThreadRow,
  UsageRow,
} from "@repo/db/agent-store";

/**
 * Storage the agent needs, the `AgentStore` port (D7): threads with their turn lock, the
 * append-only transcript, staged changesets, spend outside the transcript, runs, and the spending
 * caps with their overrides. `createD1AgentStore` (`@repo/db/agent-store`) backs it with Drizzle on
 * D1 (`store-port.typecheck.ts` checks that it fits); `createMemoryAgentStore` (memory-store.ts)
 * backs it with arrays for tests.
 *
 * The port is declared here and `@repo/db` keeps a structurally equal twin (`AgentStoreTable`), so
 * db never imports services and tsc fails when the two drift. The row types the port speaks are
 * db's, re-exported below so services import one path.
 */
export type AgentStore = {
  /** Takes the thread's turn lock when it is free or its lease ran out. */
  acquireLock(threadId: string, lockId: string, now: Date): Promise<LockResult>;
  addOverride(row: BudgetOverride): Promise<void>;
  /**
   * Appends in order, atomically, and touches the thread (and records `decisionsReportedAt` when
   * given). `settleUsage`: `streaming` usage rows now covered by these rows, deleted in the same
   * transaction. Fails (unique seq) if another request appended first.
   */
  append(
    threadId: string,
    rows: StoredMessage[],
    opts?: { at?: Date; decisionsReportedAt?: Date; settleUsage?: string[] }
  ): Promise<void>;
  changesets(threadId: string): Promise<ChangesetRow[]>;
  /** These changesets (a run's, across its item threads), oldest first. */
  changesetsByIds(ids: string[]): Promise<ChangesetRow[]>;
  createRun(run: Run): Promise<void>;
  createThread(row: ThreadRow): Promise<void>;
  decide(
    id: string,
    status: ChangesetStatus,
    decision: NonNullable<Changeset["decision"]>,
    at: Date
  ): Promise<boolean>;
  /** Deletes transcript rows of a turn that never got an answer (see the module comment). */
  deleteRows(threadId: string, seqs: number[]): Promise<void>;
  /** Removes a thread nothing was stored in (its first turn was stopped or failed). */
  deleteThreadIfEmpty(id: string): Promise<boolean>;
  getChangeset(id: string): Promise<ChangesetRow | null>;
  /** The agent models offered for new threads; null = the built-in list. */
  getModels(): Promise<AgentModel[] | null>;
  getRun(id: string): Promise<Run | null>;
  getSettings(): Promise<BudgetSettings | null>;
  getThread(id: string): Promise<ThreadRow | null>;
  insertChangeset(row: ChangesetRow): Promise<void>;
  /** Newest first; one thread's runs, or every run. */
  listRuns(opts: { threadId?: string; limit?: number }): Promise<Run[]>;
  /** Site-wide conversations, newest first. */
  listSiteThreads(): Promise<ThreadSummary[]>;
  /** The page's own conversations (scope `page`). */
  listThreads(pageId: string): Promise<ThreadSummary[]>;
  /** Images in the transcripts that reference this media item (media deletion guard). */
  mediaRefs(mediaId: string): Promise<number>;
  messages(threadId: string): Promise<StoredMessage[]>;
  /** Overrides for this thread (if any), this run (if any) and this day. */
  overrides(
    threadId: string | null,
    day: string,
    runId?: string | null
  ): Promise<BudgetOverride[]>;
  /** Inserts the row, or updates kind, model, usage and cost of the row with its id. */
  recordUsage(row: UsageRow): Promise<void>;
  releaseLock(threadId: string, lockId: string): Promise<void>;
  /** Extends the lease; false when the lock was lost (taken over). */
  renewLock(threadId: string, lockId: string, now: Date): Promise<boolean>;
  /** Asks the running turn to stop (it polls the thread). False when nothing is running. */
  requestStop(threadId: string): Promise<boolean>;
  saveModels(models: AgentModel[], by: string | null, at: Date): Promise<void>;
  /** Compare-and-set on `run.version` (the version read); stores `version + 1`. False when another write came first. */
  saveRun(run: Run): Promise<boolean>;
  saveSettings(
    settings: BudgetSettings,
    by: string | null,
    at: Date
  ): Promise<void>;
  /** Pending changesets for `pageId` staged by site-wide runs (in item threads, or a site thread for older runs). */
  siteChangesets(pageId: string): Promise<ChangesetRow[]>;
  /** Every pending changeset from any thread (or only `pageId`'s), newest first: the review queue. */
  pendingChangesets(pageId?: string): Promise<PendingChangeset[]>;
  /** All agent spend since `at`. */
  spentSince(at: Date): Promise<number>;
  /** Marks the thread's pending changesets of `kind` for `pageId` as superseded. */
  supersede(
    threadId: string,
    pageId: string,
    kind: "ops" | "seo"
  ): Promise<void>;
  /** Clears a lock taken more than LOCK_TAKEOVER_AFTER_MS ago (and tells its turn to stop). */
  takeOver(threadId: string, now: Date): Promise<boolean>;
  /** Transcript and outside-the-transcript spend of one thread. */
  threadCost(id: string): Promise<number>;
};

// biome-ignore lint/performance/noBarrelFile: one import path for the agent store's port and row types.
export {
  type BudgetSettings,
  type ChangesetRow,
  DEFAULT_BUDGET_SETTINGS,
  type LockResult,
  type PendingChangeset,
  type StoredMessage,
  type ThreadRow,
  threadModel,
  toChangeset,
  type UsageRow,
} from "@repo/db/agent-store";
