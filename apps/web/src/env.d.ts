/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

// Secrets beyond what `wrangler types` derives from wrangler.jsonc. Typegen only adds the ones
// present in the local .env files at the time it runs, so they are declared here (optional) for a
// clean checkout to typecheck. They go on `Cloudflare.Env`, the type of `env` from
// `cloudflare:workers`, and on the global `Env` below.
// biome-ignore lint/style/noNamespace: merges into the `Cloudflare` namespace wrangler generates; there is no other way to extend it.
declare namespace Cloudflare {
  // biome-ignore lint/suspicious/noShadow: augments `Cloudflare.Env` on purpose (declaration merging), not a new type.
  interface Env {
    /** Comma-separated email allowlist for /admin (case-insensitive). */
    ADMIN_EMAILS?: string;
    /** Claude API key for the CMS page agent. Optional. */
    ANTHROPIC_API_KEY?: string;
    CLERK_PUBLISHABLE_KEY?: string;
    CLERK_SECRET_KEY?: string;
    /** Dev login (apps/web/.env.local only; never set in a deployed environment). */
    DEV_LOGIN_EMAIL?: string;
    DEV_LOGIN_PASSWORD?: string;
    /** Search Console OAuth client and refresh token. Optional. */
    GSC_CLIENT_ID?: string;
    GSC_CLIENT_SECRET?: string;
    GSC_REFRESH_TOKEN?: string;
    /** HMAC key for CMS render tokens: draft previews and share-image renders. */
    PREVIEW_SIGNING_KEY?: string;
  }
}

// The same list on the global `Env`: it extends the generated base on its own, and a member
// declared here is the only way to override what that base says.
interface Env {
  /** Comma-separated email allowlist for /admin (case-insensitive). */
  ADMIN_EMAILS?: string;
  /** Claude API key for the CMS page agent. Optional. */
  ANTHROPIC_API_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  /** Dev login (apps/web/.env.local only; never set in a deployed environment). */
  DEV_LOGIN_EMAIL?: string;
  DEV_LOGIN_PASSWORD?: string;
  /** Search Console OAuth client and refresh token. Optional. */
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REFRESH_TOKEN?: string;
  /** HMAC key for CMS render tokens: draft previews and share-image renders. */
  PREVIEW_SIGNING_KEY?: string;
}

/**
 * Set by vite.config.ts: true in a dev server started with CF_REMOTE_BINDINGS=0, where the remote
 * Workers AI binding can't run (the agent shows its models as unavailable). Undefined under bun test.
 */
declare const __WORKERS_AI_OFF__: boolean;
