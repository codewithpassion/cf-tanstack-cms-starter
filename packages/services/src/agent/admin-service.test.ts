import { describe, expect, it } from "bun:test";
import { validatePageDoc } from "@repo/cms-core/validate";
import { createMemoryKv } from "../testing/memory-kv";
import { createMemoryRepo } from "../testing/memory-repo";
import {
  type AgentAdminDeps,
  createAgentAdminService,
  listAgentThreads,
  raiseAgentBudget,
  saveAgentSettings,
} from "./admin-service";
import { createMemoryAgentStore } from "./memory-store";

const NOW = Date.parse("2026-10-02T03:00:00Z");

function deps(): AgentAdminDeps & {
  store: ReturnType<typeof createMemoryAgentStore>;
} {
  let n = 0;
  const store = createMemoryAgentStore();
  return {
    store,
    cms: {
      repo: createMemoryRepo().repo,
      kv: createMemoryKv().kv,
      validate: validatePageDoc,
      labelFor: (t) => t,
    },
    availability: { anthropic: true, workersAi: false },
    actor: { userId: "u1", email: "admin@example.com" },
    now: () => NOW,
    genId: () => {
      n += 1;
      return `id${n}`;
    },
  };
}

describe("agent admin service", () => {
  it("raises the day's cap with who and when, counted in the site's day", async () => {
    const d = deps();
    await d.store.saveSettings(
      { threadCapUsd: 3, dailyCapUsd: 1 },
      null,
      new Date(NOW)
    );
    const res = await raiseAgentBudget(d, { scope: "day", amount: 20 });
    expect(res.ok).toBe(true);
    expect(d.store.rows.overrides).toEqual([
      expect.objectContaining({
        scope: "day",
        day: "2026-10-02",
        amountUsd: 20,
        createdBy: "admin@example.com",
      }),
    ]);
    if (res.ok) {
      expect(res.budget.day.capUsd).toBe(21);
    }
  });

  it("counts the day in the site's time zone", async () => {
    const d = { ...deps(), timeZone: "Pacific/Auckland" };
    const res = await raiseAgentBudget(d, { scope: "day", amount: null });
    expect(res.ok && res.budget.day.day).toBe("2026-10-02");
    expect(d.store.rows.overrides[0]?.day).toBe("2026-10-02");
    const utc = await listAgentThreads(
      { ...deps(), now: () => Date.parse("2026-10-02T23:30:00Z") },
      { pageId: "p1" }
    );
    const nz = await listAgentThreads(
      {
        ...deps(),
        timeZone: "Pacific/Auckland",
        now: () => Date.parse("2026-10-02T23:30:00Z"),
      },
      { pageId: "p1" }
    );
    expect(utc.ok && utc.budget.day.day).toBe("2026-10-02");
    expect(nz.ok && nz.budget.day.day).toBe("2026-10-03");
  });

  it("refuses an amount that isn't an offered step, before touching the store", () => {
    expect(() =>
      raiseAgentBudget(deps(), { scope: "day", amount: 7 })
    ).toThrow();
  });

  it("reports an unknown conversation as NOT_FOUND", async () => {
    const res = await raiseAgentBudget(deps(), {
      scope: "thread",
      threadId: "nope",
      amount: 5,
    });
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("saves caps rounded to cents, null for no cap", async () => {
    const d = deps();
    const res = await saveAgentSettings(d, {
      threadCapUsd: 2.456,
      dailyCapUsd: null,
    });
    expect(res).toEqual({
      ok: true,
      settings: { threadCapUsd: 2.46, dailyCapUsd: null },
    });
    expect(await d.store.getSettings()).toEqual({
      threadCapUsd: 2.46,
      dailyCapUsd: null,
    });
    expect(() =>
      saveAgentSettings(d, { threadCapUsd: 0, dailyCapUsd: null })
    ).toThrow();
  });

  it("binds the deps: the bound service returns the same results", async () => {
    const service = createAgentAdminService(deps());
    const settings = await service.getAgentSettings();
    expect(settings).toMatchObject({ ok: true, saved: false });
    const models = await service.getAgentModels();
    expect(models.ok && models.models.some((m) => m.available)).toBe(true);
  });

  it("returns an accept without a draftVersion as a typed result, not a throw", async () => {
    const res = await createAgentAdminService(deps()).decideChangeset({
      changesetId: "cs1",
      status: "accepted",
      accepted: [],
      rejected: [],
    });
    expect(res).toMatchObject({ ok: false, code: "STALE_DRAFT" });
  });

  it("returns a run-state refusal as a result", async () => {
    const service = createAgentAdminService(deps());
    expect(await service.discardRunPlan({ runId: "missing" })).toMatchObject({
      ok: false,
    });
  });
});
