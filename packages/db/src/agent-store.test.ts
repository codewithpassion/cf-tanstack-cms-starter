import { describe, expect, it } from "bun:test";

import { LOCK_LEASE_MS } from "@repo/cms-core/agent/limits";
import type { Run } from "@repo/cms-core/agent/run";

import {
  type ChangesetRow,
  createD1AgentStore,
  DEFAULT_BUDGET_SETTINGS,
  type StoredMessage,
  type ThreadRow,
} from "./agent-store.ts";
import { createTestDb } from "./test-utils.ts";

const at = (ms: number) => new Date(ms);
const thread = (id = "t1", over: Partial<ThreadRow> = {}): ThreadRow => ({
  id,
  pageId: "p1",
  title: "Thread",
  author: null,
  createdAt: at(1),
  updatedAt: at(1),
  ...over,
});
const msg = (seq: number, costUsd: number | null = null): StoredMessage => ({
  seq,
  role: seq % 2 ? "assistant" : "user",
  content: [{ type: "text", text: `m${seq}` }],
  costUsd,
  createdAt: at(10 + seq),
});
const changeset = (
  id: string,
  over: Partial<ChangesetRow> = {}
): ChangesetRow => ({
  id,
  threadId: "t1",
  pageId: "p1",
  kind: "ops",
  summary: "s",
  status: "pending",
  payload: { ops: [] },
  baseDoc: {} as never,
  proposedDoc: {} as never,
  warnings: null,
  decision: null,
  createdAt: at(5),
  decidedAt: null,
  ...over,
});

async function setup() {
  const { db, sqlite } = createTestDb();
  const store = createD1AgentStore(db);
  await store.createThread(thread());
  return { db, sqlite, store };
}

describe("transcript", () => {
  it("appends a turn's rows together, touches the thread, and fails on a duplicate seq", async () => {
    const { store } = await setup();
    await store.append("t1", [msg(0), msg(1, 0.5)], {
      decisionsReportedAt: at(99),
    });
    expect((await store.messages("t1")).map((m) => m.seq)).toEqual([0, 1]);
    expect(await store.getThread("t1")).toMatchObject({
      decisionsReportedAt: at(99),
    });
    expect((await store.getThread("t1"))?.updatedAt).toEqual(at(11));
    // A concurrent append of seq 1 rolls the whole batch back (seq 2 is not stored either).
    await expect(store.append("t1", [msg(2), msg(1)])).rejects.toThrow();
    expect((await store.messages("t1")).map((m) => m.seq)).toEqual([0, 1]);
  });

  it("chunks long appends under D1's parameter limit", async () => {
    const { store } = await setup();
    await store.append(
      "t1",
      Array.from({ length: 30 }, (_, i) => msg(i))
    );
    expect((await store.messages("t1")).length).toBe(30);
  });

  it("settles streaming usage rows in the same transaction", async () => {
    const { store } = await setup();
    await store.recordUsage({
      id: "u1",
      threadId: "t1",
      kind: "streaming",
      model: null,
      usage: null,
      costUsd: 0.1,
      createdAt: at(3),
    });
    await store.append("t1", [msg(0, 0.2)], { settleUsage: ["u1"] });
    expect(await store.threadCost("t1")).toBeCloseTo(0.2);
  });

  it("sums transcript and outside-transcript spend, per thread and since a time", async () => {
    const { store } = await setup();
    await store.append("t1", [msg(0, 0.25)]);
    await store.recordUsage({
      id: "u1",
      threadId: "t1",
      kind: "retry",
      model: "m",
      usage: { in: 1 },
      costUsd: 0.5,
      createdAt: at(500),
    });
    // recordUsage upserts by id.
    await store.recordUsage({
      id: "u1",
      threadId: "t1",
      kind: "error",
      model: "m",
      usage: null,
      costUsd: 0.75,
      createdAt: at(500),
    });
    expect(await store.threadCost("t1")).toBeCloseTo(1);
    expect(await store.spentSince(at(400))).toBeCloseTo(0.75);
    expect(await store.spentSince(at(0))).toBeCloseTo(1);
    expect((await store.listThreads("p1"))[0]?.costUsd).toBeCloseTo(1);
  });

  it("deleteRows removes only the named seqs; mediaRefs counts transcript references", async () => {
    const { store } = await setup();
    await store.append("t1", [
      msg(0),
      { ...msg(1), content: [{ type: "image", id: "media:abc" }] },
    ]);
    expect(await store.mediaRefs("abc")).toBe(1);
    expect(await store.mediaRefs("zzz")).toBe(0);
    await store.deleteRows("t1", [1]);
    expect((await store.messages("t1")).map((m) => m.seq)).toEqual([0]);
  });
});

describe("turn lock", () => {
  it("takes a free lock, refuses a held one, and takes it again once the lease lapsed", async () => {
    const { store } = await setup();
    expect(await store.acquireLock("t1", "L1", at(1000))).toEqual({ ok: true });
    expect(
      await store.acquireLock("t1", "L2", at(1000 + LOCK_LEASE_MS - 1))
    ).toEqual({
      ok: false,
      lockAt: at(1000),
    });
    expect(
      await store.acquireLock("t1", "L2", at(1000 + LOCK_LEASE_MS + 1))
    ).toEqual({
      ok: true,
    });
    expect((await store.getThread("t1"))?.lockId).toBe("L2");
  });

  it("renews and releases only for the lock's owner; stop is recorded against the lock", async () => {
    const { store } = await setup();
    await store.acquireLock("t1", "L1", at(1000));
    expect(await store.renewLock("t1", "other", at(2000))).toBe(false);
    expect(await store.renewLock("t1", "L1", at(2000))).toBe(true);
    expect(await store.requestStop("t1")).toBe(true);
    expect((await store.getThread("t1"))?.stopRequested).toBe("L1");
    await store.releaseLock("t1", "other");
    expect((await store.getThread("t1"))?.lockId).toBe("L1");
    await store.releaseLock("t1", "L1");
    expect(await store.getThread("t1")).toMatchObject({
      lockId: null,
      stopRequested: null,
    });
    expect(await store.requestStop("t1")).toBe(false);
  });
});

describe("changesets", () => {
  it("decides a pending proposal once, supersedes by kind, and lists the review queue", async () => {
    const { store } = await setup();
    await store.insertChangeset(changeset("c1"));
    await store.insertChangeset(changeset("c2", { createdAt: at(6) }));
    await store.insertChangeset(
      changeset("c3", { kind: "seo", createdAt: at(7) })
    );
    expect(
      await store.decide("c1", "accepted", { by: "me" } as never, at(9))
    ).toBe(true);
    expect(
      await store.decide("c1", "rejected", { by: "me" } as never, at(10))
    ).toBe(false);
    await store.supersede("t1", "p1", "ops");
    expect((await store.getChangeset("c2"))?.status).toBe("superseded");
    expect((await store.getChangeset("c3"))?.status).toBe("pending");
    expect((await store.pendingChangesets()).map((c) => c.id)).toEqual(["c3"]);
    expect((await store.pendingChangesets("other")).length).toBe(0);
    expect(
      (await store.changesetsByIds(["c3", "c1", "c1"])).map((c) => c.id)
    ).toEqual(["c1", "c3"]);
  });

  it("deletes an empty thread, but not one holding changesets", async () => {
    const { store } = await setup();
    await store.createThread(thread("t2"));
    expect(await store.deleteThreadIfEmpty("t2")).toBe(true);
    await store.insertChangeset(changeset("c1"));
    expect(await store.deleteThreadIfEmpty("t1")).toBe(false);
  });
});

describe("runs, settings and overrides", () => {
  const run = (over: Partial<Run> = {}): Run =>
    ({
      id: "run_1",
      threadId: "t1",
      status: "proposed",
      summary: "plan",
      items: [],
      costUsd: 0,
      provider: "anthropic",
      model: "claude-opus-5-5",
      createdAt: at(1).toISOString(),
      updatedAt: at(1).toISOString(),
      approvedAt: null,
      revertedAt: null,
      revertedBy: null,
      version: 0,
      ...over,
    }) as Run;

  it("saves a run only from the version it read (compare-and-set) and bumps it", async () => {
    const { store } = await setup();
    await store.createRun(run());
    expect(await store.saveRun(run({ status: "active" }))).toBe(true);
    expect(await store.getRun("run_1")).toMatchObject({
      status: "active",
      version: 1,
    });
    expect(await store.saveRun(run({ status: "done" }))).toBe(false);
    expect((await store.listRuns({ threadId: "t1" })).length).toBe(1);
    expect((await store.listRuns({ threadId: "nope" })).length).toBe(0);
  });

  it("keeps caps and models in one settings row; models default the caps", async () => {
    const { store } = await setup();
    expect(await store.getSettings()).toBeNull();
    expect(await store.getModels()).toBeNull();
    await store.saveModels(
      [{ provider: "anthropic", id: "m", label: "M", enabled: true }],
      "me",
      at(1)
    );
    expect(await store.getSettings()).toEqual(DEFAULT_BUDGET_SETTINGS);
    await store.saveSettings(
      { threadCapUsd: null, dailyCapUsd: 7 },
      "me",
      at(2)
    );
    expect(await store.getSettings()).toEqual({
      threadCapUsd: null,
      dailyCapUsd: 7,
    });
    expect(await store.getModels()).toEqual([
      { provider: "anthropic", id: "m", label: "M", enabled: true },
    ]);
  });

  it("returns the overrides for this thread, this run and this day only", async () => {
    const { store } = await setup();
    const o = (
      id: string,
      scope: "thread" | "day" | "run",
      threadId: string | null,
      day: string | null
    ) => ({
      id,
      scope,
      threadId,
      day,
      amountUsd: 5,
      createdBy: null,
      createdAt: at(1).toISOString(),
    });
    await store.addOverride(o("o1", "thread", "t1", null));
    await store.addOverride(o("o2", "thread", "t2", null));
    await store.addOverride(o("o3", "day", null, "2026-10-03"));
    await store.addOverride(o("o4", "day", null, "2026-10-02"));
    await store.addOverride(o("o5", "run", "run_1", null));
    expect(
      (await store.overrides("t1", "2026-10-03")).map((x) => x.id)
    ).toEqual(["o1", "o3"]);
    expect(
      (await store.overrides(null, "2026-10-03", "run_1")).map((x) => x.id)
    ).toEqual(["o3", "o5"]);
  });
});
