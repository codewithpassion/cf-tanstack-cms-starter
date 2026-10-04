# Agent rules

A starter for a website with a built-in CMS. `apps/web` is TanStack Start on Vite, served by Hono on Cloudflare Workers. Bun is the package manager, script runner and test runner. Read `docs/architecture.md` before adding a layer or a binding; `docs/cms.md` says what the CMS does.

## Tooling

- `bun install`, `bun run <script>`, `bunx <tool>`, `bun test`. Bun loads `.env` files itself; don't add dotenv.
- `bun run check` lints and typechecks the repo (Ultracite, which wraps Biome, and `tsc`); `bun run fix` formats. Run `bunx ultracite check <paths>` on what you touched. The code-style rules are in `.claude/CLAUDE.md`.
- Tests are `bun test` in each package; `bun run test` at the root runs all of them. Fix a failing test; don't skip it.
- Wrangler config is `apps/web/wrangler.jsonc`. Local values go in `apps/web/.env.local` (never `.dev.vars`), and `.env.example` lists every key.
- Writing in docs and comments: plain and short, sentence-case headings, no em dashes.

## Layout and layers

```
apps/web            routes, tRPC routers, adapters, MCP and OAuth, the CMS UI
packages/cms-core   pure code: documents, block definitions, ops engine, SEO, agent pure modules
packages/db         Drizzle schema, migrations, D1 table modules
packages/services   business rules over ports
```

A request goes route component, then tRPC router (`apps/web/src/server/trpc/routers/`), then service (`@repo/services/<module>`), then table module (`@repo/db/<module>`). Routers stay thin: an input schema, then one service call. Validation and rules go in the service.

Where things are wired:

- `apps/web/src/server/cms/wiring.ts`: `cmsServices(env, ...)` builds every service and the `SiteConfig` per request. `server/cms/agent-runtime.ts` does the same for the agent.
- `apps/web/src/server/adapters/`: Cloudflare implementations of the ports (KV, R2, Workers AI, Browser Run, Anthropic, Search Console, OAuth grants).
- `apps/web/src/server/mcp/`: the MCP server, its tools and the OAuth endpoints. `server/routes/` holds the thin raw endpoints.
- `apps/web/src/modules/cms/`: blocks, editor, renderer, admin UI, agent UI.

These are not tRPC, on purpose: multipart media upload (`admin/api/media`), the agent stream (`admin/api/agent`), `/mcp` and the OAuth endpoints, `/media/:id`, `og-render*`, sitemap, llms, robots, `oauth/authorize`.

## Rules that are easy to break

**`@repo/cms-core` stays pure.** No React, drizzle, `cloudflare:workers`, `@tanstack/*` or `env`. Only `zod` and `nanoid` are dependencies. Anything that needs the site's name, origin, time zone or a key takes a parameter; build a `SiteConfig` only with `siteConfig()` from `site/config`. One `exports` entry per module, no barrel files.

**Services take ports.** They never read `env`, bindings or the request, and never import `cloudflare:workers`. Expected failures come back as `adminResult` unions or `CmsError`/`OpError`; only auth failures are `TRPCError`, in the router. A new service goes in `server/cms/wiring.ts`.

**Browser imports (D19).** Browser code may `import type` from `@repo/services/*` but never import a runtime value from it. Runtime values the browser needs live in `@repo/cms-core` or `@repo/db/shared`. `@repo/db` itself and its table modules pull drizzle into the bundle. After touching client code, run `bun run build` in `apps/web` and check `grep -rli drizzle apps/web/dist/client` finds nothing.

**Database.** Table modules take a drizzle instance and never make one. The D1-only modules (`pages`, `site`, `media`, `gsc`, `agent-store`) take a `D1Db` because they use `db.batch` for atomic compare-and-set; see `packages/db/README.md`. No validation in `@repo/db`. Row types come from `@repo/db`; `@repo/cms-core` never imports it.

**tRPC.** No `createServerFn`; call `getTrpc()` from `#/integrations/trpc/client`, which runs in-process during SSR. superjson is the transformer on `initTRPC` and on every client link. There are three procedure kinds in `server/trpc/init.ts`: `publicProcedure`, `protectedProcedure` and `adminProcedure`. Admin routers call `.input()` after `adminProcedure`, so admin is asserted before input is parsed. Raw admin routes call `assertAdminApi` before they read a body.

**Clerk is mandatory.** `src/lib/clerk-skip.ts` lists the cookieless public paths. `/api/health` is registered before the Clerk middleware.

**Secrets.** Every secret is declared in `apps/web/src/env.d.ts` on both `Cloudflare.Env` and `Env`, so a checkout without `.env.local` typechecks. Never print `.env.local`. `DEV_LOGIN_*` must never be set on a deployed Worker.

**UI.**
- Prompts, confirms and alerts are in-app dialogs. Native `window.prompt`, `confirm` and `alert` freeze browser automation.
- Client-side ids come from `nanoid`; `crypto.randomUUID` is undefined on a plain-http origin.
- shadcn `DialogContent` widths use `sm:max-w-*`; its built-in `sm:max-w-sm` overrides a bare `max-w-*`.
- Tables set `[overflow-wrap:normal]`; the body sets `overflow-wrap: anywhere`.
- `apps/web/src/components/ui/`, `lib/utils.ts` and `hooks/use-mobile.ts` are shadcn CLI output. Never hand-edit them and put nothing else in `components/ui/`. See `apps/web/src/components/ui/CLAUDE.md`.

**Model output.** It goes in `user`, `assistant` and tool turns. `role: system` holds only our own prompt text.

**CMS code style.** `biome.jsonc` overrides the CMS paths: `type` aliases, not `interface` (interfaces aren't assignable to `Record<string, unknown>`, which the ops engine needs), and no key, attribute or class sorting (schema key order is the inspector's field order). Don't use `any`.

## How to add a block

1. Write the def in `packages/cms-core/src/blocks/<name>.ts` with `defineBlock`: `type`, `version`, `label`, `icon` (a kebab-case lucide name from `blocks/icon-names.ts`), `category`, the zod `schema`, `defaults`, `elements`, `ai` guidance, and `migrate` when the schema changes later. Add it to `BLOCK_TYPES` and `BLOCK_DEFS` in `blocks/registry.ts`. A new icon goes in `icon-names.ts` and in `BLOCK_ICONS` in the web registry together.
2. Write the Component in `apps/web/src/modules/cms/blocks/<name>.tsx` and add it to `UI` in `apps/web/src/modules/cms/blocks/registry.ts`. Build on `blocks/ui.tsx`. Both registries are typed so a missing entry fails to compile.
3. Test it: cms-core's `registry.test.ts` covers every def; add cases for the schema, defaults and migration. In `apps/web`, `blocks.test.tsx` renders the Components against each def's `elements`.
4. Run `bun test` in `packages/cms-core` and `apps/web`, then the typecheck.

## How to add a table

1. Edit `packages/db/src/schema.ts`. Add a table module in `packages/db/src/` and an `exports` entry for it in `package.json`.
2. From `packages/db`, run `bun run generate`. Commit the new migration and `migrations/meta/`. Never edit a migration that has been applied; schema changes go in a new one.
3. Add a port type and a service in `packages/services`, tested against `createTestDb()`. Wire it in `server/cms/wiring.ts`, then add a router.
4. Local dev applies migrations on start (`wrangler d1 migrations apply DB --local`). `bun run deploy` applies them remotely first.

## Dev login and local dev

`/login` has a "Dev login (local only)" link in dev builds. It hits `GET /api/dev-login`, which mints a Clerk sign-in token for a dedicated dev user and redeems it at `/dev-login`, so you get a real session without Clerk's UI. It works only when `DEV_LOGIN_EMAIL` and `DEV_LOGIN_PASSWORD` are set in `apps/web/.env.local`. Create or refresh the user with `bun run create-dev-user` from `apps/web`. Use it when testing through browser automation.

- `CF_REMOTE_BINDINGS=0 bun run dev` (from `apps/web`) starts without a Cloudflare login; Workers AI is then off.
- `CI=1` makes local Browser Run (share images) work on hosts that restrict user namespaces.
- Dev login mints admin sessions. For browser tests, bind the dev server to one known address (loopback, or a private network address you control), never `0.0.0.0` or a shared LAN address.
- Dev login and Clerk need a secure context. When the browser reaches the dev server over plain http on a non-loopback host, forward it to `127.0.0.1` (for example with `socat`).
- OAuth for MCP works on `localhost` and `127.0.0.1` only; elsewhere use API keys.
- `SITE_ORIGIN` empty works only in dev (the request origin is used). A deployed Worker needs it.

## Deploy and project setup

A copy of the starter becomes a project through `/project-init` (the user types it; the skill disables model invocation). It runs `rename-project`, connects Clerk, then `setup-cloudflare` (D1, two KV namespaces, R2, secrets, vars, deploy), then tells the user to import the starter content at `/admin/setup`. When asked how to start or deploy, point to `/project-init` and don't redo its steps by hand. A sign a copy is not set up on Cloudflare yet: `database_id` and the KV ids in `wrangler.jsonc` are still `"local"`.

`bun run deploy` in `apps/web` builds, applies remote D1 migrations, then runs `wrangler deploy`. `docs/cms-go-live.md` is the checklist before going public. Pull request previews are not part of this repo.

## Changing the design

See `docs/design.md` and the `restyle` skill.
