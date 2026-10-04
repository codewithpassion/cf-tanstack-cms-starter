import { describe, expect, it } from "bun:test";

import { gscPageDays } from "@repo/db";
import { createTestDb } from "@repo/db/test-utils";

import { type GscClient, GscError } from "./client";
import { GSC_CRON, runGscCron, SYNC_DAYS } from "./cron";
import { createD1GscStore } from "./d1";

/**
 * The source checked `GSC_CRON` against wrangler.jsonc; that file belongs to the web app, so the
 * check moves there. These cover the run itself.
 */

const U = "https://example.com";
const config = { origin: U };
const NOW = new Date("2026-10-02T03:00:00Z");

function fakeClient(opts: { failSync?: boolean } = {}) {
  const calls: { startDate: string; endDate: string }[] = [];
  const inspected: string[] = [];
  const client: GscClient = {
    searchAnalytics(q) {
      calls.push(q);
      if (opts.failSync) {
        return Promise.reject(new GscError("UPSTREAM", "boom", 500));
      }
      return Promise.resolve([
        {
          keys: q.dimensions.includes("query")
            ? ["2026-09-30", `${U}/`, "q", "MOBILE"]
            : ["2026-09-30", `${U}/`],
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: 3,
        },
      ]);
    },
    inspectUrl(url) {
      inspected.push(url);
      return Promise.resolve({ verdict: "PASS" });
    },
    submitSitemap: () => Promise.resolve(),
  };
  return { client, calls, inspected };
}

describe("runGscCron", () => {
  it("is a daily cron expression", () => {
    expect(GSC_CRON.split(" ")).toHaveLength(5);
  });

  it("skips (and says so) without a client", async () => {
    const { db } = createTestDb();
    const lines: string[] = [];
    const result = await runGscCron({
      client: null,
      store: createD1GscStore(db),
      config,
      log: (m) => lines.push(m),
    });
    expect(result.gsc).toBe("skipped");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ gsc: "skipped" });
  });

  it("re-pulls the last SYNC_DAYS Search Console days and logs one ok line", async () => {
    const { db } = createTestDb();
    const fake = fakeClient();
    const lines: string[] = [];
    const result = await runGscCron({
      client: fake.client,
      store: createD1GscStore(db),
      config,
      clock: () => NOW,
      log: (m) => lines.push(m),
    });
    expect(result).toMatchObject({ gsc: "ok", errors: [] });
    expect(fake.calls[0]).toMatchObject({
      startDate: "2026-09-22",
      endDate: "2026-10-01",
    });
    expect(SYNC_DAYS).toBe(10);
    expect(await db.$count(gscPageDays)).toBe(1);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ gsc: "ok" });
  });

  it("still inspects when the pull fails, then throws naming the failed step", async () => {
    const { db } = createTestDb();
    const fake = fakeClient({ failSync: true });
    const lines: string[] = [];
    let inspectRan = false;
    const store = createD1GscStore(db);
    await expect(
      runGscCron({
        client: fake.client,
        store: {
          ...store,
          lastInspections: () => {
            inspectRan = true;
            return store.lastInspections();
          },
        },
        config,
        clock: () => NOW,
        log: (m) => lines.push(m),
      })
    ).rejects.toThrow("sync: boom");
    expect(inspectRan).toBe(true);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      gsc: "failed",
      sync: null,
    });
  });
});
