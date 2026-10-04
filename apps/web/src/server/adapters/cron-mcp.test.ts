import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createTestEnv } from "../mcp/test-env";
import { pruneMcpCallsDaily } from "./cron-mcp";

afterEach(() => mock.restore());

test("prunes without a site origin: only D1 is needed", async () => {
  const { env } = createTestEnv();
  spyOn(console, "log").mockImplementation(() => undefined);
  const result = await pruneMcpCallsDaily({
    ...env,
    SITE_ORIGIN: "",
  } as unknown as Env);
  expect(result).toBeNull();
});
