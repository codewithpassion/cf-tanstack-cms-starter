import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { GSC_CRON } from "@repo/services/gsc/cron";
import { scheduled } from "./scheduled";
// biome-ignore lint/performance/noNamespaceImport: spy on the real module and restore it after each test.
import * as gsc from "./server/adapters/cron-gsc";
// biome-ignore lint/performance/noNamespaceImport: spy on the real module and restore it after each test.
import * as prune from "./server/adapters/cron-mcp";

const CRONS_RE = /"crons"\s*:\s*\[([^\]]*)\]/;
const env = {} as Env;
const controller = {
  cron: GSC_CRON,
  scheduledTime: 123,
} as ScheduledController;
afterEach(() => mock.restore());

function setup(pruneError: string | null = null) {
  const events: string[] = [];
  const pruneJob = spyOn(prune, "pruneMcpCallsDaily").mockImplementation(() => {
    events.push("prune");
    return Promise.resolve(pruneError);
  });
  const gscJob = spyOn(gsc, "runGscDaily").mockImplementation(() => {
    events.push("gsc");
    return Promise.resolve({ gsc: "skipped", reason: "test" });
  });
  return { events, gscJob, pruneJob };
}

test("the daily cron runs the cleanup, then Search Console", async () => {
  const { events } = setup();
  await scheduled(controller, env);
  expect(events).toEqual(["prune", "gsc"]);
});

test("a failed cleanup still runs Search Console, then fails the run", async () => {
  const { events } = setup("cleanup unavailable");
  await expect(scheduled(controller, env)).rejects.toThrow(
    "MCP call log cleanup failed: cleanup unavailable"
  );
  expect(events).toEqual(["prune", "gsc"]);
});

test("a Search Console failure fails the run with its own error", async () => {
  const { events, gscJob } = setup();
  const error = new Error("Search Console run failed: sync: AUTH");
  gscJob.mockRejectedValue(error);
  await expect(scheduled(controller, env)).rejects.toBe(error);
  expect(events).toEqual(["prune"]);
});

test("another cron runs neither job", async () => {
  const { events, pruneJob, gscJob } = setup();
  spyOn(console, "log").mockImplementation(() => undefined);
  await scheduled({ ...controller, cron: "0 0 * * *" }, env);
  expect(events).toEqual([]);
  expect(pruneJob).not.toHaveBeenCalled();
  expect(gscJob).not.toHaveBeenCalled();
});

test("wrangler.jsonc triggers the daily cron", async () => {
  const text = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const crons = CRONS_RE.exec(text)?.[1] ?? "";
  expect(crons).toContain(`"${GSC_CRON}"`);
});
