// Test helper (bun only, never imported by app code): an `Env` for the MCP server's tests.
import { createTestDb } from "@repo/db/test-utils";
import { createMemoryKv } from "@repo/services/testing/memory-kv";

import { cmsServices } from "../cms/wiring";

export const TEST_ORIGIN = "https://example.com";
export const TEST_SITE_NAME = "Example Site";

/** An in-memory stand-in for the R2 bucket: `put` and `get` of whole objects. */
export function createMemoryBlobs() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string }
  >();
  const toBytes = async (value: unknown): Promise<Uint8Array> => {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
  };
  const blobs = {
    async put(
      key: string,
      value: unknown,
      options?: { httpMetadata?: { contentType?: string } }
    ) {
      objects.set(key, {
        bytes: await toBytes(value),
        contentType: options?.httpMetadata?.contentType,
      });
      return { key };
    },
    get(key: string) {
      const o = objects.get(key);
      return Promise.resolve(
        o
          ? {
              arrayBuffer: () =>
                Promise.resolve(o.bytes.slice().buffer as ArrayBuffer),
              httpMetadata: { contentType: o.contentType },
            }
          : null
      );
    },
    delete(key: string) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return { blobs, objects };
}

/**
 * A real SQLite database behind the D1 API (every migration applied), in-memory KV for pages and
 * OAuth, an in-memory R2 bucket, a signing key and the site vars. `services` is `cmsServices(env)`,
 * for setting up and checking rows. No BROWSER, AI or ANTHROPIC_API_KEY.
 */
export function createTestEnv() {
  const { d1, sqlite } = createTestDb();
  const media = createMemoryBlobs();
  const env = {
    DB: d1,
    CMS_PAGES: createMemoryKv().kv,
    OAUTH_KV: createMemoryKv().kv,
    CMS_MEDIA: media.blobs,
    PREVIEW_SIGNING_KEY: "k".repeat(64),
    SITE_NAME: TEST_SITE_NAME,
    SITE_ORIGIN: TEST_ORIGIN,
    GSC_PROPERTY: "",
  } as unknown as Env;
  return { env, sqlite, media, services: cmsServices(env) };
}
