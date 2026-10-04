// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import {
  approveRun,
  cancelRun,
  decideItem,
  discardRun,
  finishItem,
  isRunId,
  newRunItems,
  nextItem,
  type Run,
  RunError,
  retryItem,
  runCounts,
  skipItem,
  startItem,
} from "./run";

const T = new Date("2026-10-02T00:00:00Z");

function proposed(): Run {
  let n = 0;
  return {
    id: "run_1",
    threadId: "t1",
    status: "proposed",
    summary: "Two location pages",
    items: newRunItems(
      [
        {
          slug: "ai-consulting-perth",
          action: "duplicate",
          from: "preview-e2e-test",
          intent: "Perth",
        },
        {
          slug: "ai-consulting-adelaide",
          action: "create",
          intent: "Adelaide",
        },
        { slug: "preview-e2e-test", action: "edit", intent: "Link to both" },
      ],
      () => `i${++n}`
    ),
    costUsd: 0.05,
    provider: "workers-ai",
    model: "@cf/zai-org/glm-5.3-flash",
    createdAt: T.toISOString(),
    updatedAt: T.toISOString(),
    approvedAt: null,
    revertedAt: null,
    revertedBy: null,
    version: 0,
  };
}

const active = () => approveRun(proposed(), proposed().items, T);

describe("run state machine", () => {
  it("a proposed plan is approved (or discarded) once", () => {
    const run = active();
    expect(run.status).toBe("active");
    expect(run.approvedAt).toBe(T.toISOString());
    expect(() => approveRun(run, run.items, T)).toThrow(RunError);
    expect(discardRun(proposed()).status).toBe("discarded");
    expect(() => discardRun(run)).toThrow(RunError);
    expect(nextItem(proposed(), { threadBusy: false })).toBeNull();
  });

  it("runs items in order: start → proposed, and finishes when every item has finished", () => {
    let run = active();
    expect(nextItem(run, { threadBusy: false })?.id).toBe("i1");
    run = startItem(run, "i1", T);
    expect(run.items[0]).toMatchObject({ status: "running", attempts: 1 });
    run = finishItem(
      run,
      "i1",
      {
        stopReason: "end_turn",
        changesetIds: ["cs1"],
        createdPageId: "p-perth",
        costUsd: 0.01,
      },
      T
    );
    expect(run.items[0]).toMatchObject({
      status: "proposed",
      createdPageId: "p-perth",
      pageId: "p-perth",
      changesetIds: ["cs1"],
      costUsd: 0.01,
    });
    expect(run.costUsd).toBeCloseTo(0.06);
    run = finishItem(
      startItem(run, "i2", T),
      "i2",
      {
        stopReason: "end_turn",
        changesetIds: [],
        createdPageId: "p-adl",
        costUsd: 0.02,
      },
      T
    );
    expect(run.status).toBe("active");
    run = finishItem(
      startItem(run, "i3", T),
      "i3",
      { stopReason: "end_turn", changesetIds: [], costUsd: 0.01 },
      T
    );
    expect(run.items[2]).toMatchObject({
      status: "skipped",
      note: "The agent proposed no changes for this page.",
    });
    expect(run.status).toBe("done");
    expect(run.costUsd).toBeCloseTo(0.09);
    expect(nextItem(run, { threadBusy: false })).toBeNull();
    expect(runCounts(run)).toMatchObject({ proposed: 2, skipped: 1 });
  });

  it("pause and resume: an interrupted item goes back to pending and keeps what it created", () => {
    let run = startItem(active(), "i1", T);
    run = finishItem(
      run,
      "i1",
      {
        stopReason: "detached",
        changesetIds: [],
        createdPageId: "p-perth",
        costUsd: 0.01,
      },
      T
    );
    expect(run.items[0]).toMatchObject({
      status: "pending",
      createdPageId: "p-perth",
    });
    expect(run.items[0]!.note).toMatch(/continues on it/);
    expect(nextItem(run, { threadBusy: false })?.id).toBe("i1");
    run = startItem(run, "i1", T);
    expect(run.items[0]!.attempts).toBe(2);
    for (const reason of ["stopped", "aborted", "budget"]) {
      expect(
        finishItem(
          run,
          "i1",
          { stopReason: reason, changesetIds: [], costUsd: 0 },
          T
        ).items[0]!.status
      ).toBe("pending");
    }
  });

  it("an item left running by a request that died resumes once the thread is free", () => {
    const run = startItem(active(), "i1", T);
    expect(nextItem(run, { threadBusy: true })?.id).toBe("i2");
    expect(nextItem(run, { threadBusy: false })?.id).toBe("i1");
    // The caller holds the lock, so a stale running item can start again.
    expect(startItem(run, "i1", T).items[0]!.attempts).toBe(2);
  });

  it("failures, skips and retries", () => {
    let run = startItem(active(), "i1", T);
    run = finishItem(
      run,
      "i1",
      {
        stopReason: "error",
        changesetIds: [],
        costUsd: 0,
        error: "Rate limited",
      },
      T
    );
    expect(run.items[0]).toMatchObject({
      status: "failed",
      note: "Rate limited",
    });
    expect(
      finishItem(
        startItem(active(), "i1", T),
        "i1",
        { stopReason: "refusal", changesetIds: [], costUsd: 0 },
        T
      ).items[0]!.status
    ).toBe("failed");
    // Something staged before an error is still reviewable.
    expect(
      finishItem(
        startItem(active(), "i1", T),
        "i1",
        { stopReason: "error", changesetIds: ["cs1"], costUsd: 0 },
        T
      ).items[0]!.status
    ).toBe("proposed");
    run = retryItem(run, "i1");
    expect(run.items[0]).toMatchObject({ status: "pending" });
    run = skipItem(run, "i1");
    expect(run.items[0]).toMatchObject({
      status: "skipped",
      note: "Skipped by you.",
    });
    expect(() => skipItem(run, "i1")).toThrow(/skipped/);
    expect(() => startItem(run, "i1", T)).toThrow(/already skipped/);
    run = skipItem(skipItem(run, "i2"), "i3");
    expect(run.status).toBe("done");
    run = retryItem(run, "i2");
    expect(run.status).toBe("active");
  });

  it("cancel skips what hasn't run; staged proposals stay", () => {
    let run = finishItem(
      startItem(active(), "i1", T),
      "i1",
      { stopReason: "end_turn", changesetIds: ["cs1"], costUsd: 0 },
      T
    );
    run = cancelRun(run);
    expect(run.status).toBe("cancelled");
    expect(run.items.map((i) => i.status)).toEqual([
      "proposed",
      "skipped",
      "skipped",
    ]);
    expect(() => startItem(run, "i2", T)).toThrow(RunError);
  });

  it("review decisions settle proposed items", () => {
    let run = finishItem(
      startItem(active(), "i1", T),
      "i1",
      {
        stopReason: "end_turn",
        changesetIds: ["cs1", "cs2"],
        createdPageId: "p",
        costUsd: 0,
      },
      T
    );
    run = decideItem(run, "i1", {
      revId: "r1",
      statuses: { cs1: "accepted", cs2: "pending" },
    });
    expect(run.items[0]).toMatchObject({
      status: "proposed",
      revisionIds: ["r1"],
    });
    run = decideItem(run, "i1", {
      revId: "r2",
      statuses: { cs1: "accepted", cs2: "rejected" },
    });
    expect(run.items[0]).toMatchObject({
      status: "accepted",
      revisionIds: ["r1", "r2"],
    });
    // A created draft with no changeset: keeping it accepts, archiving rejects.
    let r2 = finishItem(
      startItem(active(), "i2", T),
      "i2",
      {
        stopReason: "end_turn",
        changesetIds: [],
        createdPageId: "p2",
        costUsd: 0,
      },
      T
    );
    expect(
      decideItem(r2, "i2", { statuses: {}, draft: "kept" }).items[1]!.status
    ).toBe("accepted");
    r2 = decideItem(r2, "i2", { statuses: {}, draft: "archived" });
    expect(r2.items[1]!.status).toBe("rejected");
    expect(() => decideItem(active(), "i1", { statuses: {} })).toThrow(
      /nothing to review/
    );
  });

  it("run ids are recognisable", () => {
    expect(isRunId("run_abc")).toBe(true);
    expect(isRunId("3f2a-thread")).toBe(false);
    expect(isRunId(null)).toBe(false);
  });
});
