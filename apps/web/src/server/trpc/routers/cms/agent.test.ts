import { describe, expect, it } from "bun:test";
import { validatePageDoc } from "@repo/cms-core/validate";
import { createAgentAdminService } from "@repo/services/agent/admin-service";
import type { AltSuggestion } from "@repo/services/agent/alt-text";
import { createMemoryAgentStore } from "@repo/services/agent/memory-store";
import { createMemoryKv } from "@repo/services/testing/memory-kv";
import { createMemoryRepo } from "@repo/services/testing/memory-repo";
import { createAgentRouter } from "./agent.ts";
import type { AdminCtx, AgentApi } from "./agent-api.ts";
import { createAgentRunsRouter } from "./agent-runs.ts";
import { ADMIN_EMAIL, ADMIN_ID, contextFor } from "./test-context.ts";

const NOW = Date.parse("2026-10-02T03:00:00Z");

/** A runtime like agent-runtime.ts builds, over the services' memory store; records who asked for it. */
function fakeApi(
  suggest: AgentApi["suggestAltText"] = () =>
    Promise.resolve({ alt: "A cat", decorative: false, costUsd: 0.001 })
) {
  const store = createMemoryAgentStore();
  const calls: AdminCtx[] = [];
  let n = 0;
  const loader = (ctx: AdminCtx): Promise<AgentApi> => {
    calls.push(ctx);
    return Promise.resolve({
      admin: createAgentAdminService({
        store,
        cms: {
          repo: createMemoryRepo().repo,
          kv: createMemoryKv().kv,
          validate: validatePageDoc,
          labelFor: (t) => t,
        },
        availability: { anthropic: true, workersAi: false },
        actor: { userId: ctx.userId, email: ctx.adminEmail },
        now: () => NOW,
        genId: () => {
          n += 1;
          return `id${n}`;
        },
      }),
      suggestAltText: suggest,
    });
  };
  return { store, calls, loader };
}

describe("agent routers: admin gate", () => {
  const cases = [
    ["anonymous", "UNAUTHORIZED"],
    ["user", "FORBIDDEN"],
  ] as const;

  for (const [who, code] of cases) {
    it(`${who} callers get ${code} and never reach the runtime`, async () => {
      const { calls, loader } = fakeApi();
      const agent = createAgentRouter(loader).createCaller(contextFor(who));
      const runs = createAgentRunsRouter(loader).createCaller(contextFor(who));
      await expect(agent.getAgentSettings()).rejects.toMatchObject({ code });
      await expect(
        agent.listAgentThreads({ pageId: "p1" })
      ).rejects.toMatchObject({ code });
      await expect(runs.listRuns()).rejects.toMatchObject({ code });
      await expect(runs.getRun({ runId: "r1" })).rejects.toMatchObject({
        code,
      });
      expect(calls).toEqual([]);
    });
  }

  it("rejects a non-admin before parsing the input", async () => {
    const { loader } = fakeApi();
    const agent = createAgentRouter(loader).createCaller(contextFor("user"));
    const runs = createAgentRunsRouter(loader).createCaller(contextFor("user"));
    // Invalid input: parsed first, these would be BAD_REQUEST.
    await expect(
      agent.raiseAgentBudget({ scope: "day", amount: 7 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runs.approveRun({ runId: 42, items: "x" } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("parses the admin's input with the services' schemas", async () => {
    const { loader } = fakeApi();
    const agent = createAgentRouter(loader).createCaller(contextFor("admin"));
    await expect(
      agent.raiseAgentBudget({ scope: "day", amount: 7 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("agent router", () => {
  it("builds the runtime for the admin and records the override as them", async () => {
    const { store, calls, loader } = fakeApi();
    const agent = createAgentRouter(loader).createCaller(contextFor("admin"));
    const res = await agent.raiseAgentBudget({ scope: "day", amount: 20 });
    expect(res.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      userId: ADMIN_ID,
      adminEmail: ADMIN_EMAIL,
    });
    expect(store.rows.overrides).toEqual([
      expect.objectContaining({ scope: "day", createdBy: ADMIN_EMAIL }),
    ]);
  });

  it("returns the service's result unions as objects", async () => {
    const { loader } = fakeApi();
    const agent = createAgentRouter(loader).createCaller(contextFor("admin"));
    expect(
      await agent.saveAgentSettings({ threadCapUsd: 2.456, dailyCapUsd: null })
    ).toEqual({
      ok: true,
      settings: { threadCapUsd: 2.46, dailyCapUsd: null },
    });
    expect(await agent.getAgentSettings()).toMatchObject({
      ok: true,
      saved: true,
    });
    expect(
      await agent.getAgentThread({ threadId: "nope", pageId: "p1" })
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("suggestAltText: a suggestion, or the service's refusal as a result", async () => {
    const seen: [string, string | undefined][] = [];
    const ok = fakeApi((id, context) => {
      seen.push([id, context]);
      return Promise.resolve({
        alt: "A cat",
        decorative: false,
        costUsd: 0.001,
      } satisfies AltSuggestion);
    });
    const agent = createAgentRouter(ok.loader).createCaller(
      contextFor("admin")
    );
    expect(
      await agent.suggestAltText({ id: "m1", context: "x".repeat(400) })
    ).toEqual({ ok: true, alt: "A cat", decorative: false, costUsd: 0.001 });
    expect(seen).toEqual([["m1", "x".repeat(300)]]);

    const refused = fakeApi(() =>
      Promise.reject(new Error("That image isn't in the media library."))
    );
    const caller = createAgentRouter(refused.loader).createCaller(
      contextFor("admin")
    );
    expect(await caller.suggestAltText({ id: "m2" })).toEqual({
      ok: false,
      message: "That image isn't in the media library.",
    });
  });
});

describe("agentRuns router", () => {
  it("lists runs and reports a missing run as a result", async () => {
    const { loader } = fakeApi();
    const runs = createAgentRunsRouter(loader).createCaller(
      contextFor("admin")
    );
    expect(await runs.listRuns()).toEqual({ ok: true, runs: [], threads: [] });
    expect(await runs.discardRun({ runId: "missing" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});
