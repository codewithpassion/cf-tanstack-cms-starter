import { describe, expect, it } from "bun:test";
import { GSC_CONNECT_HINT } from "@repo/cms-core/gsc/shape";
import { sampleDoc } from "@repo/cms-core/test-fixtures";
import type { GscClient } from "@repo/services/gsc/client";
import { createTestEnv } from "../../../mcp/test-env.ts";
import { gscRouter } from "./gsc.ts";
import { setupRouter } from "./setup.ts";
import { contextFor } from "./test-context.ts";

async function setup() {
  const { services } = createTestEnv();
  const doc = sampleDoc();
  const page = await services.pages.createPage({
    kind: "page",
    slug: "services/a",
    title: "A",
    doc: { ...doc, seo: { ...doc.seo, slug: "services/a" } },
  });
  return { services, page };
}

describe("gsc router", () => {
  it("is admin only, before the input is checked", async () => {
    const { services } = await setup();
    const user = gscRouter.createCaller(contextFor("user", services));
    await expect(
      user.getPagePerformance({ pageId: "x", days: 30 as 28 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(user.submitSitemap()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      gscRouter
        .createCaller(contextFor("anonymous", services))
        .getSeoGscOverview()
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("reads D1 and says Search Console isn't connected", async () => {
    const { services, page } = await setup();
    const admin = gscRouter.createCaller(contextFor("admin", services));
    await expect(
      admin.getPagePerformance({ pageId: page.id, days: 30 as 28 })
    ).rejects.toThrow('Expected \\"days\\" to be 28 or 90');
    expect(
      await admin.getPagePerformance({ pageId: page.id, days: 28 })
    ).toMatchObject({ ok: true, connected: false });
    expect(
      await admin.getPagePerformance({ pageId: "missing", days: 90 })
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await admin.getSeoGscOverview()).toMatchObject({
      ok: true,
      connected: false,
    });
    await expect(
      admin.getSeoGscOverview({ minImpressions: -1 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answers the Google calls with a message instead of throwing", async () => {
    const { services, page } = await setup();
    const admin = gscRouter.createCaller(contextFor("admin", services));
    expect(await admin.inspectPageNow({ pageId: page.id })).toEqual({
      ok: false,
      message: "Only published pages can be inspected.",
    });
    expect(await admin.submitSitemap()).toEqual({
      ok: false,
      message: GSC_CONNECT_HINT,
    });
  });
});

describe("setup router: Search Console backfill", () => {
  it("plans month windows and checks the month count", async () => {
    const { services } = await setup();
    const admin = setupRouter.createCaller(contextFor("admin", services));
    const plan = await admin.planGscBackfill({ months: 3 });
    expect(plan.ok && plan.configured).toBe(false);
    expect(plan.ok && plan.windows.length).toBeGreaterThanOrEqual(3);
    for (const months of [0, 17, 1.5]) {
      // biome-ignore lint/performance/noAwaitInLoops: one case at a time keeps failures readable.
      await expect(admin.planGscBackfill({ months })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(
      await setupRouter
        .createCaller(contextFor("admin", services))
        .setupStatus()
    ).toMatchObject({ ok: true, pages: 1, gscConfigured: false });
  });

  it("pulls one window with the client, and refuses without one", async () => {
    const { services } = await setup();
    const admin = setupRouter.createCaller(contextFor("admin", services));
    await expect(
      admin.runGscBackfillMonth({ start: "2026-01-01", end: "2026-03-01" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      admin.runGscBackfillMonth({ start: "2026-01-01", end: "2026-01-31" })
    ).rejects.toThrow(GSC_CONNECT_HINT);

    const asked: unknown[] = [];
    const client: GscClient = {
      searchAnalytics: (q) => {
        asked.push(q);
        return Promise.resolve([]);
      },
      inspectUrl: () => Promise.reject(new Error("not used")),
      submitSitemap: () => Promise.reject(new Error("not used")),
    };
    const withClient = setupRouter.createCaller(
      contextFor("admin", { ...services, gscClient: client })
    );
    expect(
      await withClient.runGscBackfillMonth({
        start: "2026-01-01",
        end: "2026-01-31",
      })
    ).toMatchObject({
      ok: true,
      summary: { start: "2026-01-01", end: "2026-01-31", rows: 0 },
    });
    expect(asked).toHaveLength(2);
  });
});
