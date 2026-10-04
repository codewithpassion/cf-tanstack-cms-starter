// biome-ignore-all lint/complexity/useOptionalChain: ported verbatim; explicit checks kept as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
// biome-ignore-all lint/suspicious/noEvolvingTypes: ported verbatim; the insert list is typed by its pushes, as in the source.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning interfaces and callbacks; kept as in the source.
import {
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_THREAD_CAP_USD,
  LOCK_LEASE_MS,
  LOCK_TAKEOVER_AFTER_MS,
} from "@repo/cms-core/agent/limits";
import {
  type AgentModel,
  type AgentProviderId,
  DEFAULT_MODEL,
  type ModelRef,
} from "@repo/cms-core/agent/models";
import type { Run } from "@repo/cms-core/agent/run";
import type {
  Changeset,
  ChangesetStatus,
  SeoProposal,
  ThreadSummary,
} from "@repo/cms-core/agent/types";
import type { Op } from "@repo/cms-core/types";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import {
  type AgentRunRow,
  agentBudgetOverrides,
  agentChangesets,
  agentMessages,
  agentRuns,
  agentSettings,
  agentThreads,
  agentUsage,
  type D1Db,
  pages,
} from "./schema.ts";
import type { PageDoc } from "./shared.ts";

/**
 * D1 storage for the agent: threads (with their turn lock), the append-only transcript, staged
 * changesets, spend outside the transcript, and the spending caps with their overrides.
 *
 * The transcript is append-only with one exception, `deleteRows`: rows after the last assistant
 * message of a turn that never got an answer (no thinking block follows them, so nothing the model
 * produced depends on them). Each thread's rows are in its provider's format.
 */

// TODO(cms-port): BudgetSettings. The budget types live with the budget rules (they were mixed
// with the store port in the source). Declared here until the services phase moves them.
export type BudgetSettings = {
  threadCapUsd: number | null;
  dailyCapUsd: number | null;
};

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  threadCapUsd: DEFAULT_THREAD_CAP_USD,
  dailyCapUsd: DEFAULT_DAILY_CAP_USD,
};

/** A raised limit: `amountUsd` null = no limit (for that thread, or that day). */
export type BudgetOverride = {
  id: string;
  /** `run`: a site-wide run's cap; `threadId` then holds the run id. */
  scope: "thread" | "day" | "run";
  threadId: string | null;
  day: string | null;
  amountUsd: number | null;
  createdBy: string | null;
  createdAt: string;
};

export type StoredMessage = {
  seq: number;
  /** `tool`: a tool result in a `workers-ai` thread. */
  role: "user" | "assistant" | "system" | "tool";
  /** Message content in the thread's provider format (server/transcript.ts). */
  content: unknown;
  model?: string | null;
  stopReason?: string | null;
  usage?: unknown;
  costUsd?: number | null;
  createdAt: Date;
};

export type ChangesetRow = {
  id: string;
  threadId: string;
  pageId: string;
  kind: "ops" | "seo";
  summary: string;
  status: ChangesetStatus;
  payload: { ops: Op[] } | SeoProposal;
  baseDoc: PageDoc;
  proposedDoc: PageDoc;
  warnings: unknown;
  decision: Changeset["decision"] | null;
  createdAt: Date;
  decidedAt: Date | null;
};

/** A pending changeset in the review queue: its thread's scope (`page`: a conversation; `site`/`item`: a run) and its page. */
export type PendingChangeset = ChangesetRow & {
  threadScope: NonNullable<ThreadRow["scope"]>;
  /** Null when the page row is gone (in-memory tests have no pages). */
  page: {
    slug: string;
    title: string;
    status: "draft" | "published" | "archived";
  } | null;
};

export type ThreadRow = {
  id: string;
  pageId: string;
  title: string;
  author: string | null;
  createdAt: Date;
  updatedAt: Date;
  lockId?: string | null;
  lockAt?: Date | null;
  lockExpiresAt?: Date | null;
  stopRequested?: string | null;
  decisionsReportedAt?: Date | null;
  /** The thread's model (fixed when it starts). Missing = the default Claude model. */
  provider?: AgentProviderId;
  model?: string;
  /** `site`: a site-wide conversation (plans and runs); `item`: one run item's transcript; missing = `page`. */
  scope?: "page" | "site" | "item";
};

/** A thread's model. */
export const threadModel = (
  t: Pick<ThreadRow, "provider" | "model">
): ModelRef =>
  t.provider && t.model ? { provider: t.provider, id: t.model } : DEFAULT_MODEL;

/**
 * Spend without a transcript row: a stopped, failed or retried model call, or (`streaming`) the
 * spend so far of a call still streaming. A `streaming` row is deleted together with the call's
 * stored message, or turned into `aborted`/`error`; one left behind is a call cut off when the
 * Worker ended (a closed tab past the `waitUntil` window), and still counts.
 */
export type UsageRow = {
  id: string;
  threadId: string;
  kind: "aborted" | "retry" | "error" | "streaming" | "alt-text";
  model: string | null;
  usage: unknown;
  costUsd: number;
  createdAt: Date;
};

export type LockResult = { ok: true } | { ok: false; lockAt: Date | null };

/**
 * What `createD1AgentStore` implements: the same shape as `AgentStore`, the agent loop's port in
 * `@repo/services`. Declared here so the methods are typed without importing services.
 */
export type AgentStoreTable = {
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

export function toChangeset(row: ChangesetRow): Changeset {
  return {
    id: row.id,
    threadId: row.threadId,
    pageId: row.pageId,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    ...(row.kind === "ops"
      ? {
          ops: (row.payload as { ops: Op[] }).ops,
          baseDocJson: JSON.stringify(row.baseDoc),
        }
      : { seo: row.payload as SeoProposal }),
    ...(Array.isArray(row.warnings) && row.warnings.length
      ? { warnings: row.warnings as Changeset["warnings"] }
      : {}),
    ...(row.decision ? { decision: row.decision } : {}),
  };
}

function threadModelFields(
  t: Pick<ThreadRow, "provider" | "model">
): Pick<ThreadSummary, "provider" | "model"> {
  const m = threadModel(t);
  return { provider: m.provider, model: m.id };
}

/** D1 binds at most 100 parameters per statement; transcript rows bind 10 each. */
const INSERT_CHUNK = 8;
const SETTINGS_ID = "default";

const costSum = (
  col: typeof agentMessages.costUsd | typeof agentUsage.costUsd
) => sql<number>`coalesce(sum(${col}), 0)`.mapWith(Number);

export function createD1AgentStore(db: D1Db): AgentStoreTable {
  type ThreadListRow = {
    id: string;
    pageId: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    provider: AgentProviderId;
    model: string;
  };
  const withCosts = async (rows: ThreadListRow[]): Promise<ThreadSummary[]> => {
    if (!rows.length) {
      return [];
    }
    // Costs in separate queries: drizzle leaves columns unqualified in single-table selects, so a correlated subquery would be ambiguous.
    const ids = rows.map((r) => r.id);
    const [costs, extra] = await Promise.all([
      db
        .select({
          threadId: agentMessages.threadId,
          cost: costSum(agentMessages.costUsd),
        })
        .from(agentMessages)
        .where(inArray(agentMessages.threadId, ids))
        .groupBy(agentMessages.threadId),
      db
        .select({
          threadId: agentUsage.threadId,
          cost: costSum(agentUsage.costUsd),
        })
        .from(agentUsage)
        .where(inArray(agentUsage.threadId, ids))
        .groupBy(agentUsage.threadId),
    ]);
    const byId = new Map<string, number>();
    for (const c of [...costs, ...extra]) {
      byId.set(c.threadId, (byId.get(c.threadId) ?? 0) + c.cost);
    }
    return rows.map((r) => ({
      id: r.id,
      pageId: r.pageId,
      title: r.title,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      costUsd: byId.get(r.id) ?? 0,
      ...threadModelFields(r),
    }));
  };
  return {
    async createThread(row) {
      await db.insert(agentThreads).values(row);
    },
    async getThread(id) {
      const [row] = await db
        .select()
        .from(agentThreads)
        .where(eq(agentThreads.id, id))
        .limit(1);
      return row ?? null;
    },
    async deleteThreadIfEmpty(id) {
      const [msg] = await db
        .select({ id: agentMessages.id })
        .from(agentMessages)
        .where(eq(agentMessages.threadId, id))
        .limit(1);
      const [cs] = await db
        .select({ id: agentChangesets.id })
        .from(agentChangesets)
        .where(eq(agentChangesets.threadId, id))
        .limit(1);
      const [run] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.threadId, id))
        .limit(1);
      if (msg || cs || run) {
        return false;
      }
      const res = await db
        .delete(agentThreads)
        .where(eq(agentThreads.id, id))
        .run();
      return res.meta.changes === 1;
    },
    async listThreads(pageId) {
      const rows = await db
        .select({
          id: agentThreads.id,
          pageId: agentThreads.pageId,
          title: agentThreads.title,
          createdAt: agentThreads.createdAt,
          updatedAt: agentThreads.updatedAt,
          provider: agentThreads.provider,
          model: agentThreads.model,
        })
        .from(agentThreads)
        .where(
          and(eq(agentThreads.pageId, pageId), eq(agentThreads.scope, "page"))
        )
        .orderBy(desc(agentThreads.updatedAt))
        .limit(50);
      return withCosts(rows);
    },
    async listSiteThreads() {
      const rows = await db
        .select({
          id: agentThreads.id,
          pageId: agentThreads.pageId,
          title: agentThreads.title,
          createdAt: agentThreads.createdAt,
          updatedAt: agentThreads.updatedAt,
          provider: agentThreads.provider,
          model: agentThreads.model,
        })
        .from(agentThreads)
        .where(eq(agentThreads.scope, "site"))
        .orderBy(desc(agentThreads.updatedAt))
        .limit(50);
      return withCosts(rows);
    },
    async threadCost(id) {
      const [[a], [b]] = await Promise.all([
        db
          .select({ cost: costSum(agentMessages.costUsd) })
          .from(agentMessages)
          .where(eq(agentMessages.threadId, id)),
        db
          .select({ cost: costSum(agentUsage.costUsd) })
          .from(agentUsage)
          .where(eq(agentUsage.threadId, id)),
      ]);
      return (a?.cost ?? 0) + (b?.cost ?? 0);
    },
    async spentSince(at) {
      const [[a], [b]] = await Promise.all([
        db
          .select({ cost: costSum(agentMessages.costUsd) })
          .from(agentMessages)
          .where(gte(agentMessages.createdAt, at)),
        db
          .select({ cost: costSum(agentUsage.costUsd) })
          .from(agentUsage)
          .where(gte(agentUsage.createdAt, at)),
      ]);
      return (a?.cost ?? 0) + (b?.cost ?? 0);
    },
    async messages(threadId) {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.threadId, threadId))
        .orderBy(asc(agentMessages.seq));
      return rows.map((r) => ({
        seq: r.seq,
        role: r.role,
        content: r.content,
        model: r.model,
        stopReason: r.stopReason,
        usage: r.usage,
        costUsd: r.costUsd,
        createdAt: r.createdAt,
      }));
    },
    async append(threadId, rows, opts = {}) {
      if (!rows.length) {
        return;
      }
      const inserts = [];
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        inserts.push(
          db.insert(agentMessages).values(
            rows.slice(i, i + INSERT_CHUNK).map((r) => ({
              id: `${threadId}:${r.seq}`,
              threadId,
              seq: r.seq,
              role: r.role,
              content: r.content,
              model: r.model ?? null,
              stopReason: r.stopReason ?? null,
              usage: r.usage ?? null,
              costUsd: r.costUsd ?? null,
              createdAt: r.createdAt,
            }))
          )
        );
      }
      const touch = db
        .update(agentThreads)
        .set({
          updatedAt: opts.at ?? rows.at(-1)!.createdAt,
          ...(opts.decisionsReportedAt && {
            decisionsReportedAt: opts.decisionsReportedAt,
          }),
        })
        .where(eq(agentThreads.id, threadId));
      const settle = opts.settleUsage?.length
        ? [
            db
              .delete(agentUsage)
              .where(inArray(agentUsage.id, opts.settleUsage)),
          ]
        : [];
      // One batch is one transaction: a turn's rows land together or not at all.
      await db.batch([inserts[0]!, ...inserts.slice(1), touch, ...settle]);
    },
    async deleteRows(threadId, seqs) {
      if (!seqs.length) {
        return;
      }
      await db
        .delete(agentMessages)
        .where(
          and(
            eq(agentMessages.threadId, threadId),
            inArray(agentMessages.seq, seqs)
          )
        );
    },
    async recordUsage(row) {
      await db
        .insert(agentUsage)
        .values(row)
        .onConflictDoUpdate({
          target: agentUsage.id,
          set: {
            kind: row.kind,
            model: row.model,
            usage: row.usage,
            costUsd: row.costUsd,
          },
        });
    },
    async acquireLock(threadId, lockId, now) {
      const res = await db
        .update(agentThreads)
        .set({
          lockId,
          lockAt: now,
          lockExpiresAt: new Date(now.getTime() + LOCK_LEASE_MS),
          stopRequested: null,
        })
        .where(
          and(
            eq(agentThreads.id, threadId),
            or(isNull(agentThreads.lockId), lt(agentThreads.lockExpiresAt, now))
          )
        )
        .run();
      if (res.meta.changes === 1) {
        return { ok: true };
      }
      const [row] = await db
        .select({ lockAt: agentThreads.lockAt })
        .from(agentThreads)
        .where(eq(agentThreads.id, threadId))
        .limit(1);
      return { ok: false, lockAt: row?.lockAt ?? null };
    },
    async renewLock(threadId, lockId, now) {
      const res = await db
        .update(agentThreads)
        .set({ lockExpiresAt: new Date(now.getTime() + LOCK_LEASE_MS) })
        .where(
          and(eq(agentThreads.id, threadId), eq(agentThreads.lockId, lockId))
        )
        .run();
      return res.meta.changes === 1;
    },
    async releaseLock(threadId, lockId) {
      await db
        .update(agentThreads)
        .set({
          lockId: null,
          lockAt: null,
          lockExpiresAt: null,
          stopRequested: null,
        })
        .where(
          and(eq(agentThreads.id, threadId), eq(agentThreads.lockId, lockId))
        );
    },
    async requestStop(threadId) {
      const res = await db
        .update(agentThreads)
        .set({ stopRequested: sql`${agentThreads.lockId}` })
        .where(
          and(
            eq(agentThreads.id, threadId),
            sql`${agentThreads.lockId} is not null`
          )
        )
        .run();
      return res.meta.changes === 1;
    },
    async takeOver(threadId, now) {
      const res = await db
        .update(agentThreads)
        .set({
          lockId: null,
          lockAt: null,
          lockExpiresAt: null,
          stopRequested: sql`${agentThreads.lockId}`,
        })
        .where(
          and(
            eq(agentThreads.id, threadId),
            lt(
              agentThreads.lockAt,
              new Date(now.getTime() - LOCK_TAKEOVER_AFTER_MS)
            )
          )
        )
        .run();
      return res.meta.changes === 1;
    },
    async mediaRefs(mediaId) {
      const needle = JSON.stringify(`media:${mediaId}`);
      const [row] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(agentMessages)
        .where(sql`instr(${agentMessages.content}, ${needle}) > 0`);
      return row?.n ?? 0;
    },
    async getSettings() {
      const [row] = await db
        .select()
        .from(agentSettings)
        .where(eq(agentSettings.id, SETTINGS_ID))
        .limit(1);
      return row
        ? { threadCapUsd: row.threadCapUsd, dailyCapUsd: row.dailyCapUsd }
        : null;
    },
    async saveSettings(settings, by, at) {
      const values = {
        id: SETTINGS_ID,
        ...settings,
        updatedAt: at,
        updatedBy: by,
      };
      await db
        .insert(agentSettings)
        .values(values)
        .onConflictDoUpdate({
          target: agentSettings.id,
          set: { ...settings, updatedAt: at, updatedBy: by },
        });
    },
    async getModels() {
      const [row] = await db
        .select({ models: agentSettings.models })
        .from(agentSettings)
        .where(eq(agentSettings.id, SETTINGS_ID))
        .limit(1);
      return (row?.models as AgentModel[] | null | undefined) ?? null;
    },
    async saveModels(models, by, at) {
      // A new settings row gets the default caps (null would mean "no cap").
      await db
        .insert(agentSettings)
        .values({
          id: SETTINGS_ID,
          ...DEFAULT_BUDGET_SETTINGS,
          models,
          updatedAt: at,
          updatedBy: by,
        })
        .onConflictDoUpdate({
          target: agentSettings.id,
          set: { models, updatedAt: at, updatedBy: by },
        });
    },
    async overrides(threadId, day, runId) {
      const rows = await db
        .select()
        .from(agentBudgetOverrides)
        .where(
          or(
            and(
              eq(agentBudgetOverrides.scope, "day"),
              eq(agentBudgetOverrides.day, day)
            ),
            threadId
              ? and(
                  eq(agentBudgetOverrides.scope, "thread"),
                  eq(agentBudgetOverrides.threadId, threadId)
                )
              : sql`0`,
            runId
              ? and(
                  eq(agentBudgetOverrides.scope, "run"),
                  eq(agentBudgetOverrides.threadId, runId)
                )
              : sql`0`
          )
        )
        .orderBy(asc(agentBudgetOverrides.createdAt));
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    },
    async addOverride(row) {
      await db
        .insert(agentBudgetOverrides)
        .values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async insertChangeset(row) {
      await db.insert(agentChangesets).values(row);
    },
    async supersede(threadId, pageId, kind) {
      await db
        .update(agentChangesets)
        .set({ status: "superseded" })
        .where(
          and(
            eq(agentChangesets.threadId, threadId),
            eq(agentChangesets.pageId, pageId),
            eq(agentChangesets.kind, kind),
            eq(agentChangesets.status, "pending")
          )
        );
    },
    async changesets(threadId) {
      const rows = await db
        .select()
        .from(agentChangesets)
        .where(eq(agentChangesets.threadId, threadId))
        .orderBy(asc(agentChangesets.createdAt));
      return rows as ChangesetRow[];
    },
    async changesetsByIds(ids) {
      const unique = [...new Set(ids)];
      const rows: ChangesetRow[] = [];
      // D1 binds at most 100 parameters per statement.
      for (let i = 0; i < unique.length; i += 90) {
        rows.push(
          ...((await db
            .select()
            .from(agentChangesets)
            .where(
              inArray(agentChangesets.id, unique.slice(i, i + 90))
            )) as ChangesetRow[])
        );
      }
      return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async getChangeset(id) {
      const [row] = await db
        .select()
        .from(agentChangesets)
        .where(eq(agentChangesets.id, id))
        .limit(1);
      return (row as ChangesetRow | undefined) ?? null;
    },
    async decide(id, status, decision, at) {
      const res = await db
        .update(agentChangesets)
        .set({ status, decision, decidedAt: at })
        .where(
          and(eq(agentChangesets.id, id), eq(agentChangesets.status, "pending"))
        )
        .run();
      return res.meta.changes === 1;
    },
    async siteChangesets(pageId) {
      const rows = await db
        .select({ cs: agentChangesets })
        .from(agentChangesets)
        .innerJoin(agentThreads, eq(agentThreads.id, agentChangesets.threadId))
        .where(
          and(
            eq(agentChangesets.pageId, pageId),
            eq(agentChangesets.status, "pending"),
            inArray(agentThreads.scope, ["site", "item"])
          )
        )
        .orderBy(asc(agentChangesets.createdAt));
      return rows.map((r) => r.cs as ChangesetRow);
    },
    async pendingChangesets(pageId) {
      const rows = await db
        .select({
          cs: agentChangesets,
          scope: agentThreads.scope,
          slug: pages.slug,
          title: pages.title,
          status: pages.status,
        })
        .from(agentChangesets)
        .innerJoin(agentThreads, eq(agentThreads.id, agentChangesets.threadId))
        .leftJoin(pages, eq(pages.id, agentChangesets.pageId))
        .where(
          and(
            eq(agentChangesets.status, "pending"),
            pageId ? eq(agentChangesets.pageId, pageId) : undefined
          )
        )
        .orderBy(desc(agentChangesets.createdAt), desc(agentChangesets.id));
      return rows.map((r) => ({
        ...(r.cs as ChangesetRow),
        threadScope: r.scope,
        page:
          r.slug !== null && r.title !== null && r.status !== null
            ? { slug: r.slug, title: r.title, status: r.status }
            : null,
      }));
    },
    async createRun(run) {
      await db.insert(agentRuns).values(toRunRow(run));
    },
    async getRun(id) {
      const [row] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id))
        .limit(1);
      return row ? fromRunRow(row) : null;
    },
    async listRuns({ threadId, limit = 50 }) {
      const rows = await db
        .select()
        .from(agentRuns)
        .where(threadId ? eq(agentRuns.threadId, threadId) : undefined)
        .orderBy(desc(agentRuns.createdAt))
        .limit(limit);
      return rows.map(fromRunRow);
    },
    async saveRun(run) {
      const { id, version, ...rest } = toRunRow(run);
      const res = await db
        .update(agentRuns)
        .set({ ...rest, version: version + 1 })
        .where(and(eq(agentRuns.id, id), eq(agentRuns.version, version)))
        .run();
      return res.meta.changes === 1;
    },
  };
}

export function toRunRow(run: Run): AgentRunRow {
  const date = (s: string | null) => (s ? new Date(s) : null);
  return {
    id: run.id,
    threadId: run.threadId,
    status: run.status,
    summary: run.summary,
    items: run.items,
    costUsd: run.costUsd,
    provider: run.provider,
    model: run.model,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
    approvedAt: date(run.approvedAt),
    revertedAt: date(run.revertedAt),
    revertedBy: run.revertedBy,
    version: run.version,
  };
}

export function fromRunRow(row: AgentRunRow): Run {
  return {
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    summary: row.summary,
    items: row.items as Run["items"],
    costUsd: row.costUsd,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    revertedBy: row.revertedBy,
    version: row.version,
  };
}
