import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createTestEnv } from "../mcp/test-env";
import { runGscDaily } from "./cron-gsc";
import { gscClientFor } from "./gsc";

afterEach(() => mock.restore());

const secrets = {
  GSC_CLIENT_ID: "id",
  GSC_CLIENT_SECRET: "secret",
  GSC_REFRESH_TOKEN: "token",
};

describe("gscClientFor", () => {
  test("is null unless all three secrets and the property are set", () => {
    expect(gscClientFor({})).toBeNull();
    expect(gscClientFor(secrets)).toBeNull();
    expect(gscClientFor({ ...secrets, GSC_PROPERTY: "  " })).toBeNull();
    expect(
      gscClientFor({ ...secrets, GSC_REFRESH_TOKEN: "", GSC_PROPERTY: "x" })
    ).toBeNull();
    expect(
      gscClientFor({ ...secrets, GSC_PROPERTY: "sc-domain:example.com" })
    ).not.toBeNull();
  });
});

describe("runGscDaily", () => {
  test("skips without the secrets, even when SITE_ORIGIN is empty", async () => {
    const { env } = createTestEnv();
    const lines: string[] = [];
    spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const result = await runGscDaily({
      ...env,
      SITE_ORIGIN: "",
    } as unknown as Env);
    expect(result).toMatchObject({ gsc: "skipped" });
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([{ gsc: "skipped" }]);
  });

  test("needs SITE_ORIGIN once Search Console is connected", () => {
    const { env } = createTestEnv();
    expect(() =>
      runGscDaily({
        ...env,
        ...secrets,
        GSC_PROPERTY: "sc-domain:example.com",
        SITE_ORIGIN: "",
      } as unknown as Env)
    ).toThrow("SITE_ORIGIN");
  });
});
