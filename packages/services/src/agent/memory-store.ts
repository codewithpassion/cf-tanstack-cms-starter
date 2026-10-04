// biome-ignore-all lint/complexity/useOptionalChain: test store; explicit checks kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: test store; indexes the code proves in range, as in the source.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy the promise-returning port, as in the source.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
import type { BudgetOverride } from "@repo/cms-core/agent/budget-types";
import {
  LOCK_LEASE_MS,
  LOCK_TAKEOVER_AFTER_MS,
} from "@repo/cms-core/agent/limits";
import type { AgentModel } from "@repo/cms-core/agent/models";
import type { Run } from "@repo/cms-core/agent/run";
import type {
  ChangesetStatus,
  ThreadSummary,
} from "@repo/cms-core/agent/types";
import {
  type AgentStore,
  type BudgetSettings,
  type ChangesetRow,
  DEFAULT_BUDGET_SETTINGS,
  type StoredMessage,
  type ThreadRow,
  threadModel,
  type UsageRow,
} from "./store-port";

function threadModelFields(
  t: Pick<ThreadRow, "provider" | "model">
): Pick<ThreadSummary, "provider" | "model"> {
  const m = threadModel(t);
  return { provider: m.provider, model: m.id };
}

export type MemoryRows = {
  runs: Run[];
  threads: ThreadRow[];
  messages: Map<string, StoredMessage[]>;
  changesets: ChangesetRow[];
  usage: UsageRow[];
  settings: BudgetSettings | null;
  models: AgentModel[] | null;
  overrides: BudgetOverride[];
};

/** In-memory store for tests. */
export function createMemoryAgentStore(): AgentStore & {
  rows: MemoryRows;
  /** `decide` without the await: the memory CMS repo's hook for deciding a proposal inside a page commit. */
  decideNow(
    id: string,
    status: ChangesetStatus,
    decision: unknown,
    at: Date
  ): boolean;
} {
  const threads: ThreadRow[] = [];
  const messages = new Map<string, StoredMessage[]>();
  const changesets: ChangesetRow[] = [];
  const rows: MemoryRows = {
    runs: [],
    threads,
    messages,
    changesets,
    usage: [],
    settings: null,
    models: null,
    overrides: [],
  };
  const clone = <T>(v: T): T => structuredClone(v);
  const thread = (id: string) => threads.find((t) => t.id === id);
  const extra = (pred: (u: UsageRow) => boolean) =>
    rows.usage.filter(pred).reduce((s, u) => s + u.costUsd, 0);
  const summaries = (list: ThreadRow[]): ThreadSummary[] =>
    list.map((t) => ({
      id: t.id,
      pageId: t.pageId,
      title: t.title,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      costUsd:
        (messages.get(t.id) ?? []).reduce((s, m) => s + (m.costUsd ?? 0), 0) +
        extra((u) => u.threadId === t.id),
      ...threadModelFields(t),
    }));
  const decideNow = (
    id: string,
    status: ChangesetStatus,
    decision: unknown,
    at: Date
  ) => {
    const c = changesets.find((x) => x.id === id);
    if (!c || c.status !== "pending") {
      return false;
    }
    Object.assign(c, { status, decision: clone(decision), decidedAt: at });
    return true;
  };
  return {
    rows,
    async createThread(row) {
      threads.push(clone(row));
    },
    async getThread(id) {
      return clone(thread(id) ?? null);
    },
    async deleteThreadIfEmpty(id) {
      if (
        (messages.get(id) ?? []).length ||
        changesets.some((c) => c.threadId === id) ||
        rows.runs.some((r) => r.threadId === id)
      ) {
        return false;
      }
      const i = threads.findIndex((t) => t.id === id);
      if (i < 0) {
        return false;
      }
      threads.splice(i, 1);
      return true;
    },
    async listThreads(pageId) {
      return summaries(
        threads.filter(
          (t) => t.pageId === pageId && (t.scope ?? "page") === "page"
        )
      );
    },
    async listSiteThreads() {
      return summaries(threads.filter((t) => t.scope === "site"));
    },
    async threadCost(id) {
      return (
        (messages.get(id) ?? []).reduce((s, m) => s + (m.costUsd ?? 0), 0) +
        extra((u) => u.threadId === id)
      );
    },
    async spentSince(at) {
      const t = at.getTime();
      const inTranscripts = [...messages.values()]
        .flat()
        .filter((m) => m.createdAt.getTime() >= t)
        .reduce((s, m) => s + (m.costUsd ?? 0), 0);
      return inTranscripts + extra((u) => u.createdAt.getTime() >= t);
    },
    async messages(threadId) {
      return clone(messages.get(threadId) ?? []);
    },
    async append(threadId, add, opts = {}) {
      const list = messages.get(threadId) ?? [];
      for (const r of add) {
        if (list.some((m) => m.seq === r.seq)) {
          throw new Error(`seq ${r.seq} already exists`);
        }
      }
      list.push(...add.map(clone));
      messages.set(threadId, list);
      if (opts.settleUsage?.length) {
        rows.usage = rows.usage.filter(
          (u) => !opts.settleUsage!.includes(u.id)
        );
      }
      const t = thread(threadId);
      if (t && add.length) {
        t.updatedAt = opts.at ?? add.at(-1)!.createdAt;
        if (opts.decisionsReportedAt) {
          t.decisionsReportedAt = opts.decisionsReportedAt;
        }
      }
    },
    async deleteRows(threadId, seqs) {
      messages.set(
        threadId,
        (messages.get(threadId) ?? []).filter((m) => !seqs.includes(m.seq))
      );
    },
    async recordUsage(row) {
      const i = rows.usage.findIndex((u) => u.id === row.id);
      if (i < 0) {
        rows.usage.push(clone(row));
      } else {
        rows.usage[i] = {
          ...rows.usage[i]!,
          kind: row.kind,
          model: row.model,
          usage: clone(row.usage),
          costUsd: row.costUsd,
        };
      }
    },
    async acquireLock(threadId, lockId, now) {
      const t = thread(threadId);
      if (!t) {
        return { ok: false, lockAt: null };
      }
      if (
        t.lockId &&
        t.lockExpiresAt &&
        t.lockExpiresAt.getTime() >= now.getTime()
      ) {
        return { ok: false, lockAt: t.lockAt ?? null };
      }
      Object.assign(t, {
        lockId,
        lockAt: now,
        lockExpiresAt: new Date(now.getTime() + LOCK_LEASE_MS),
        stopRequested: null,
      });
      return { ok: true };
    },
    async renewLock(threadId, lockId, now) {
      const t = thread(threadId);
      if (!t || t.lockId !== lockId) {
        return false;
      }
      t.lockExpiresAt = new Date(now.getTime() + LOCK_LEASE_MS);
      return true;
    },
    async releaseLock(threadId, lockId) {
      const t = thread(threadId);
      if (t?.lockId === lockId) {
        Object.assign(t, {
          lockId: null,
          lockAt: null,
          lockExpiresAt: null,
          stopRequested: null,
        });
      }
    },
    async requestStop(threadId) {
      const t = thread(threadId);
      if (!t?.lockId) {
        return false;
      }
      t.stopRequested = t.lockId;
      return true;
    },
    async takeOver(threadId, now) {
      const t = thread(threadId);
      if (
        !t?.lockAt ||
        t.lockAt.getTime() >= now.getTime() - LOCK_TAKEOVER_AFTER_MS
      ) {
        return false;
      }
      Object.assign(t, {
        stopRequested: t.lockId,
        lockId: null,
        lockAt: null,
        lockExpiresAt: null,
      });
      return true;
    },
    async mediaRefs(mediaId) {
      const needle = JSON.stringify(`media:${mediaId}`);
      return [...messages.values()]
        .flat()
        .filter((m) => JSON.stringify(m.content).includes(needle)).length;
    },
    async getSettings() {
      return clone(rows.settings);
    },
    async saveSettings(settings) {
      rows.settings = clone(settings);
    },
    async getModels() {
      return clone(rows.models);
    },
    async saveModels(models) {
      rows.models = clone(models);
      rows.settings ??= { ...DEFAULT_BUDGET_SETTINGS };
    },
    async overrides(threadId, day, runId) {
      return clone(
        rows.overrides.filter(
          (o) =>
            (o.scope === "day" && o.day === day) ||
            (o.scope === "thread" &&
              threadId !== null &&
              o.threadId === threadId) ||
            (o.scope === "run" && !!runId && o.threadId === runId)
        )
      );
    },
    async addOverride(row) {
      rows.overrides.push(clone(row));
    },
    async insertChangeset(row) {
      changesets.push(clone(row));
    },
    async supersede(threadId, pageId, kind) {
      for (const c of changesets) {
        if (
          c.threadId === threadId &&
          c.pageId === pageId &&
          c.kind === kind &&
          c.status === "pending"
        ) {
          c.status = "superseded";
        }
      }
    },
    async changesets(threadId) {
      return clone(changesets.filter((c) => c.threadId === threadId));
    },
    async changesetsByIds(ids) {
      return clone(changesets.filter((c) => ids.includes(c.id)));
    },
    async getChangeset(id) {
      return clone(changesets.find((c) => c.id === id) ?? null);
    },
    decideNow,
    async decide(id, status, decision, at) {
      return decideNow(id, status, decision, at);
    },
    async siteChangesets(pageId) {
      const site = new Set(
        threads
          .filter((t) => t.scope === "site" || t.scope === "item")
          .map((t) => t.id)
      );
      return clone(
        changesets.filter(
          (c) =>
            c.pageId === pageId &&
            c.status === "pending" &&
            site.has(c.threadId)
        )
      );
    },
    async pendingChangesets(pageId) {
      return clone(
        changesets
          .filter(
            (c) => c.status === "pending" && (!pageId || c.pageId === pageId)
          )
          .map((c) => ({
            ...c,
            threadScope: thread(c.threadId)?.scope ?? "page",
            page: null,
          }))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      );
    },
    async createRun(run) {
      rows.runs.push(clone(run));
    },
    async getRun(id) {
      return clone(rows.runs.find((r) => r.id === id) ?? null);
    },
    async listRuns({ threadId, limit = 50 }) {
      return clone(
        rows.runs
          .filter((r) => !threadId || r.threadId === threadId)
          .reverse()
          .slice(0, limit)
      );
    },
    async saveRun(run) {
      const i = rows.runs.findIndex((r) => r.id === run.id);
      if (i < 0 || rows.runs[i]!.version !== run.version) {
        return false;
      }
      rows.runs[i] = clone({ ...run, version: run.version + 1 });
      return true;
    },
  };
}
