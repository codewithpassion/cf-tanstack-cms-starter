// Test helper (bun only, never imported by app code): an `Env` for the MCP server's tests.
import { createTestDb } from "@repo/db/test-utils";
import { createMemoryKv } from "@repo/services/testing/memory-kv";

import { cmsServices } from "../cms/wiring";

export const TEST_ORIGIN = "https://example.com";
export const TEST_SITE_NAME = "Example Site";

/**
 * A real SQLite database behind the D1 API (every migration applied), in-memory KV for pages and
 * OAuth, and the site vars. `services` is `cmsServices(env)`, for setting up and checking rows.
 */
export function createTestEnv() {
  const { d1, sqlite } = createTestDb();
  const env = {
    DB: d1,
    CMS_PAGES: createMemoryKv().kv,
    OAUTH_KV: createMemoryKv().kv,
    SITE_NAME: TEST_SITE_NAME,
    SITE_ORIGIN: TEST_ORIGIN,
    GSC_PROPERTY: "",
  } as unknown as Env;
  return { env, sqlite, services: cmsServices(env) };
}
