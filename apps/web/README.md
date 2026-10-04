# Boilerplate

A [TanStack Start](https://tanstack.com/start) app deployed on Cloudflare Workers, with [Hono](https://hono.dev) as the top-level `fetch` handler and [Cloudflare D1](https://developers.cloudflare.com/d1/) for data.

Auth is [Clerk](https://clerk.com): `/login` signs in, the header shows the signed-in user.

## Architecture

`src/server.ts` is the Worker's entry point (`main` in `wrangler.jsonc`). It's a Hono app:

- Hono handles its own routes first (e.g. `/api/health`).
- `/api/trpc/*` is the [tRPC](https://trpc.io) API, mounted with `@hono/trpc-server`.
- Everything else falls through to `app.all('*', ...)`, which delegates to TanStack Start's request handler (`@tanstack/react-start/server-entry`) for SSR pages and static assets.

## tRPC

`src/server/trpc/` holds the API:

- `context.ts` builds `ctx` for each call: the services from [`@repo/services`](../../packages/services) on this request's `drizzle(env.DB)`, and `userId`, the signed-in user or null. `userId` comes from the Clerk session: `getAuth(c)` over HTTP, `auth()` during SSR. `adminEmails` (from `ADMIN_EMAILS`) and `auth.verifiedEmails()` (a lazy, memoised Clerk lookup) are what `adminProcedure` checks.
- `init.ts` defines `publicProcedure` (anyone) `protectedProcedure` (signed-in users only, 401 otherwise) and `adminProcedure` (signed-in users whose verified email is in `ADMIN_EMAILS`, 403 otherwise). superjson is the transformer, here and on both client links.
- `router.ts` is the app router: `me` (protected) and `isAdmin` (admin) are the examples. TODO(cms-port): the CMS routers are mounted here.
- `routers/<name>.ts` holds one router per area. Keep them thin: an input schema from the service, then one service call.

`src/integrations/trpc/client.ts` exports `getTrpc()`. In the browser it is an HTTP client for `/api/trpc`. During SSR it runs the router in-process (`unstable_localLink`), so loaders do not fetch their own Worker. Call it from loaders and event handlers: `getTrpc().me.query()`.

## D1

Database access goes through the workspace package [`@repo/db`](../../packages/db) (see its README for the schema, the migrations and the test setup). In this app:

- `wrangler.jsonc` declares the `d1_databases` binding named `DB`, with `migrations_dir` pointing at `packages/db/migrations`. `bun run cf-typegen` turns that into `env.DB: D1Database`.
- `src/server/trpc/context.ts` calls `drizzle(env.DB)` from `drizzle-orm/d1` and hands it to the services. That is the one place the binding is read.
- Browser code imports only `@repo/db/shared`. The other entries import drizzle and belong behind tRPC.

`bun run dev` runs `wrangler d1 migrations apply DB --local` before starting Vite, so the local database that Miniflare serves is always up to date. It lives in `.wrangler`, which is gitignored; delete that folder for a clean slate.

## Bindings

`wrangler.jsonc` declares them, each with a comment: `DB` (D1), `CMS_PAGES` and `OAUTH_KV` (KV), `CMS_MEDIA` (R2), `AI`, `BROWSER`, a daily cron, and the vars `SITE_NAME`, `SITE_ORIGIN`, `GSC_PROPERTY`. Secrets are listed in `.env.example` and declared in `src/env.d.ts`. TODO(cms-port): the CMS code that uses them arrives in later phases.

## Develop

```bash
bun install
bun run dev
```

The database needs no configuration for local work. Clerk needs keys in `.env.local` (copy `.env.example`); without them `/api/health` still answers, but pages error. To start without a Cloudflare login (Workers AI is the only remote binding) use `CF_REMOTE_BINDINGS=0 bun run dev`.

## Build & deploy

The local database only exists on your machine, so the deployed Worker needs a real D1 database. Create one, put the id it prints into `d1_databases[0].database_id` in `wrangler.jsonc`, and create the tables:

```bash
bunx wrangler d1 create boilerplate-cms
bunx wrangler d1 migrations apply DB --remote
```

Then:

```bash
bun run build     # vite build
bun run deploy    # build + wrangler deploy
```

`wrangler.jsonc` has no `account_id` set, so `wrangler deploy`/`wrangler whoami` will use (or prompt for) whichever Cloudflare account is active.

`bun run cf-typegen` regenerates `worker-configuration.d.ts` (the `Env` type) from `wrangler.jsonc` + local env vars — it also runs automatically via `prepare` (`bun install`), so a fresh clone typechecks without a manual step.
