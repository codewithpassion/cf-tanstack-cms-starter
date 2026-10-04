# Boilerplate

A [TanStack Start](https://tanstack.com/start) app deployed on Cloudflare Workers, with [Hono](https://hono.dev) as the top-level `fetch` handler and [Cloudflare D1](https://developers.cloudflare.com/d1/) for data.

Auth is [Clerk](https://clerk.com): `/login` signs in. `/admin` is limited to the emails in `ADMIN_EMAILS`. It hosts the CMS; see [docs/cms.md](../../docs/cms.md).

## Architecture

`src/server.ts` is the Worker's entry point (`main` in `wrangler.jsonc`). It's a Hono app:

- Hono handles its own routes first (e.g. `/api/health`).
- `/api/trpc/*` is the [tRPC](https://trpc.io) API, mounted with `@hono/trpc-server`.
- Everything else falls through to `app.all('*', ...)`, which delegates to TanStack Start's request handler (`@tanstack/react-start/server-entry`) for SSR pages and static assets.

## tRPC

`src/server/trpc/` holds the API:

- `context.ts` builds `ctx` for each call: `services.cms` (every service from [`@repo/services`](../../packages/services), built per request by `server/cms/wiring.ts`), and `userId`, the signed-in user or null. `userId` comes from the Clerk session: `getAuth(c)` over HTTP, `auth()` during SSR. `adminEmails` (from `ADMIN_EMAILS`) and `auth.verifiedEmails()` (a lazy, memoised Clerk lookup) are what `adminProcedure` checks.
- `init.ts` defines `publicProcedure` (anyone) `protectedProcedure` (signed-in users only, 401 otherwise) and `adminProcedure` (signed-in users whose verified email is in `ADMIN_EMAILS`, 403 otherwise). superjson is the transformer, here and on both client links.
- `router.ts` is the app router: `me`, `isAdmin` and the `cms.*` routers (`agent`, `agentRender`, `agentRuns`, `apiKeys`, `gsc`, `media`, `ogRender`, `pages`, `posts`, `preview`, `public`, `seo`, `setup`, `shareImage`, `site`).
- `routers/cms/<name>.ts` holds one router per area. Keep them thin: an input schema from the service, then one service call.

`src/integrations/trpc/client.ts` exports `getTrpc()`. In the browser it is an HTTP client for `/api/trpc`. During SSR it runs the router in-process (`unstable_localLink`), so loaders do not fetch their own Worker. Call it from loaders and event handlers: `getTrpc().me.query()`.

## D1

Database access goes through the workspace package [`@repo/db`](../../packages/db) (see its README for the schema, the migrations and the test setup). In this app:

- `wrangler.jsonc` declares the `d1_databases` binding named `DB`, with `migrations_dir` pointing at `packages/db/migrations`. `bun run cf-typegen` turns that into `env.DB: D1Database`.
- `src/server/cms/wiring.ts` calls `drizzle(env.DB, { schema })` from `drizzle-orm/d1` and hands it to the table modules and services. That is the one place the binding is read.
- Browser code imports only `@repo/db/shared`. The other entries import drizzle and belong behind tRPC.

`bun run dev` runs `wrangler d1 migrations apply DB --local` before starting Vite, so the local database that Miniflare serves is always up to date. It lives in `.wrangler`, which is gitignored; delete that folder for a clean slate.

## Bindings

`wrangler.jsonc` declares them, each with a comment: `DB` (D1), `CMS_PAGES` and `OAUTH_KV` (KV), `CMS_MEDIA` (R2), `AI`, `BROWSER`, a daily cron, and the vars `SITE_NAME`, `SITE_ORIGIN`, `SITE_TIME_ZONE`, `GSC_PROPERTY`. Secrets are listed in `.env.example` and declared in `src/env.d.ts`. The adapters in `src/server/adapters/` turn the bindings into the ports the services use.

## Routes that are not tRPC

Thin TanStack file routes, with their logic in `src/server/routes/`: `/media/$id` (R2, public), `POST /admin/api/media` (multipart upload), `POST`/`DELETE /admin/api/agent` (the agent's server-sent stream), `/og-render/*` and `/og-render-agent/$pageId` (token-gated pages that Browser Run screenshots), `/sitemap.xml`, `/llms.txt`, `/llms-full.txt`, `/robots.txt`. The MCP server (`/mcp`) and the OAuth endpoints are in `src/server/mcp/`; `server.ts` answers the OAuth metadata, token and register paths before Clerk. Cookieless paths are listed in `src/lib/clerk-skip.ts`.

Admin writes outside tRPC check the `Origin` header (CSRF) and assert admin before they read the body. The cron (`scheduled.ts`) prunes the MCP call log and runs the Search Console sync.

## MCP

`/mcp` accepts a bearer API key (`cms_live_...`, or `cms_dev_...` in local dev) or an OAuth token. Keys and connections are managed at `/admin/api-keys`; the tools, scopes and connection steps are in [docs/cms.md](../../docs/cms.md). The server name is `SITE_NAME` as a slug.

## Develop

```bash
bun install
cp .env.example .env.local   # Clerk keys, ADMIN_EMAILS, PREVIEW_SIGNING_KEY
CF_REMOTE_BINDINGS=0 bun run dev
```

The database needs no configuration for local work: `bun run dev` applies the migrations to the Miniflare database in `.wrangler` first. Clerk needs keys in `.env.local`; without them `/api/health` still answers, but pages error. `CF_REMOTE_BINDINGS=0` skips the one remote binding (Workers AI), so dev starts without a Cloudflare login. For the one-click dev login, set `DEV_LOGIN_EMAIL` and `DEV_LOGIN_PASSWORD` and run `bun run create-dev-user`. Scripts: `gsc:auth`, `gsc:backfill`, `gsc:sync` for Search Console.

## Build and deploy

A deployed Worker needs real resources: a D1 database, two KV namespaces and an R2 bucket, with their ids in `wrangler.jsonc`, plus the secrets and `SITE_ORIGIN`. `/project-init` (the `setup-cloudflare` skill) creates and records all of it. By hand, the order and commands are in `.claude/skills/setup-cloudflare/SKILL.md`.

```bash
bun run build     # vite build
bun run deploy    # build + remote D1 migrations + wrangler deploy
```

`wrangler.jsonc` has no `account_id` set, so wrangler uses (or prompts for) the active Cloudflare account; set `CLOUDFLARE_ACCOUNT_ID` in `.env.local` to pin it.

`bun run cf-typegen` regenerates `worker-configuration.d.ts` (the `Env` type) from `wrangler.jsonc` and local env vars. It also runs through `prepare` (`bun install`), so a fresh clone typechecks without a manual step.
