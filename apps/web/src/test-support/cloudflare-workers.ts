import { mock } from "bun:test";

/**
 * `bun test` preload (bunfig.toml). @cloudflare/workers-oauth-provider imports `WorkerEntrypoint`
 * from `cloudflare:workers` at the top, which only exists in workerd: a stand-in class is enough.
 * App code under test still must not import `cloudflare:workers` itself (its `env` is empty here).
 *
 * `Cloudflare.compatibilityFlags` is what the Workers runtime exposes; the library only fetches
 * Client ID Metadata Documents with `global_fetch_strictly_public` on (wrangler.jsonc).
 */
mock.module("cloudflare:workers", () => ({
  env: {},
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

(globalThis as { Cloudflare?: unknown }).Cloudflare = {
  compatibilityFlags: { global_fetch_strictly_public: true },
};
