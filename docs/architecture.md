# Architecture

The decisions below are fixed. Change one only on purpose, and update this file in the same commit.

The repo is a Turborepo (Bun workspaces): `apps/web` (TanStack Start on Vite, served by Hono on Cloudflare Workers), `packages/cms-core`, `packages/db`, `packages/services`. It holds a built-in CMS: core blocks, an iframe editor, publish to KV, previews, an SEO tab, share images, sitemap and llms.txt, site settings (nav, footer, swatches), a blog, R2 media, an MCP server with API keys and OAuth, an AI page agent with site-wide runs, and Search Console sync.

## 1. Packages and layers

- `@repo/cms-core` (`packages/cms-core`): isomorphic pure code. Page document types, the ops engine, the block definitions, validation, SEO checks, reserved slugs, the site doc schema, style vars, richtext helpers, paths, sitemap and llms builders, and the agent's pure modules. No drizzle, no React, no Cloudflare, no `env`. One `exports` entry per module, no barrel.
- `@repo/db` (`packages/db`): the Drizzle schema for every CMS table, one migration generated from the whole schema (`0000_cms`), and the table modules (pages, site, media, Search Console, agent store, API keys, OAuth connections). `shared.ts` holds browser-safe types and constants. The D1 modules use `db.batch` for atomic compare-and-set, so they take a `DrizzleD1Database` (`D1Db`), not the generic `Database` type. They are tested on `createTestDb()`, a D1-shaped stand-in over `bun:sqlite`.
- `@repo/services` (`packages/services`): business rules. Factories that take ports: repos, a KV-like port, an R2-like port, `validate` and `labelFor` functions, model providers (Anthropic, Workers AI), a clock. They never read `env` and never import `cloudflare:workers`. Pages, site, posts, history, preview, render tokens, publish, media, API keys, OAuth connections, the agent (turns, runs, tools, budget), Search Console sync. Tested against in-memory fakes of the ports and, where it matters, the real table modules.
- `apps/web`: TanStack Start on Vite, served by Hono.
  - `src/server/trpc/`: context, procedures, and one router per area under `routers/cms/`.
  - `src/server/cms/`: `wiring.ts` builds every service and the `SiteConfig` per request; `agent-runtime.ts` builds the agent's dependencies.
  - `src/server/adapters/`: the Cloudflare implementations of the ports (KV and R2 fit as they are; Workers AI, Browser Run, Anthropic, Search Console, OAuth grants, share images, cron jobs).
  - `src/server/mcp/`: the MCP server, its tools and the OAuth endpoints. `src/server/routes/`: the thin raw endpoints.
  - `src/modules/cms/`: blocks, editor, renderer, admin UI, agent UI.

The layers: route component, then tRPC router, then service, then table module. A router is an input schema and one service call. Blocks are split in two. The pure definition (schema, defaults, guidance, an icon name) is in `@repo/cms-core`; the React Component, icon and `hiddenWhen` are in `apps/web/src/modules/cms/blocks/registry.ts`, which zips them. `validate` is injected into services, so services never import React.

Browser imports: browser code may `import type` from `@repo/services/*`, never a runtime value. Runtime values it needs (MCP scopes, the author format, the `adminResult` constants, media byte helpers) live in `@repo/cms-core`, or in `@repo/db/shared` when they depend on db types. `@repo/db` and its table modules never reach the client bundle; `grep -rli drizzle apps/web/dist/client` must find nothing after a build.

Row types are inferred from the schema and exported by `@repo/db`. Services may `import type` them; `@repo/cms-core` must not import `@repo/db`.

## 2. RPC

tRPC carries every browser-to-server call. `superjson` is the transformer on `initTRPC` and on both client links (`apps/web/src/integrations/trpc/client.ts`), because results contain `Date`s. These stay as Hono or TanStack server routes, not tRPC: multipart media upload (`admin.api.media`), the agent stream (`admin.api.agent`), `/mcp` and the OAuth endpoints, `/media/:id`, `og-render*`, sitemap, llms, robots, and `oauth.authorize`.

## 3. Errors

Procedures return `adminResult` unions (`{ ok: true, ... }` or `{ ok: false, code, message }`) for failures the UI shows, and `CmsError`/`OpError` from services map onto them. Only auth failures are `TRPCError`: UNAUTHORIZED redirects the browser to `/login?redirect_url=<current path>` (`src/integrations/trpc/auth-redirect.ts`), FORBIDDEN is shown as an error. Bad input is BAD_REQUEST with the first zod message.

## 4. Admin gate

`adminProcedure = protectedProcedure.use(...)` in `apps/web/src/server/trpc/init.ts`. Admins come from the `ADMIN_EMAILS` secret: comma-separated, trimmed, case-insensitive, matched against the signed-in Clerk user's verified email addresses. It fails closed: an empty list, missing Clerk keys or an unverified address mean no admin. Anonymous callers get UNAUTHORIZED, signed-in non-admins FORBIDDEN.

`context.ts` carries what the check needs: `ctx.adminEmails` (the parsed allowlist) and `ctx.auth.verifiedEmails()`, a lazy lookup of the user's verified addresses through Clerk's backend API, memoised per request so ordinary procedures never pay for it. Routers call `.input()` after `adminProcedure`, so admin is asserted before input parsing (tRPC runs middleware first). `init.test.ts` covers this.

## 5. Clerk is mandatory

The admin area needs it. The provider, `/login`, `/dev-login`, `create-dev-user` and the Clerk-aware tRPC context are part of the code. Clerk's middleware runs in both layers (the Hono app in `server.ts`, Start's request middleware in `start.ts`), except for the cookieless public paths in `src/lib/clerk-skip.ts`. `/api/health` is registered before the middleware, so it answers without Clerk keys. `/project-init` always sets Clerk up.

## 6. Examples in the docs

The READMEs use the CMS table modules as the examples. There is no sample table.

## 7. Bindings

`apps/web/wrangler.jsonc`, each commented there:

| Binding | Kind | Used for |
| --- | --- | --- |
| `DB` | D1 (`<project>-cms`) | all CMS data; migrations in `packages/db/migrations` |
| `CMS_PAGES` | KV (`<project>-cms-pages`) | published page snapshots |
| `OAUTH_KV` | KV (`<project>-cms-oauth`) | MCP OAuth clients, grants and tokens |
| `CMS_MEDIA` | R2 (`<project>-cms-media`) | uploaded media |
| `AI` | Workers AI (`remote: true`) | the page agent's second provider |
| `BROWSER` | Browser Run | share images, agent render target |

Cron `0 18 * * *` runs the Search Console sync. `workers_dev` is `true`, so a deploy ends on a workers.dev URL; MCP OAuth tokens are bound to the host that issued them, so a later move to a custom domain means re-authorising MCP clients. The compatibility flags are `nodejs_compat` and `global_fetch_strictly_public` (the OAuth provider needs the latter).

Vars: `SITE_NAME`, `SITE_ORIGIN`, `SITE_TIME_ZONE` (IANA, default `UTC`) and `GSC_PROPERTY` (optional). `SITE_ORIGIN` is required in a deploy: `siteConfig()` throws on an empty origin, so every CMS request fails until it is set. Only in `bun run dev` does an empty value fall back to the request origin. Secrets: the Clerk keys, `ADMIN_EMAILS`, `PREVIEW_SIGNING_KEY`, `ANTHROPIC_API_KEY` (optional), `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` (optional). Every secret is declared in `apps/web/src/env.d.ts` on both `Cloudflare.Env` and `Env`, so a checkout without `.env.local` typechecks.

## 8. Generic names

MCP key prefixes are `cms_live_` and `cms_dev_`; the MCP server name comes from the `SITE_NAME` slug. Resource names are `<project>-cms-*`: `rename-project` rewrites the D1 and R2 names in `wrangler.jsonc`, and `setup-cloudflare` creates the two KV namespaces from the Worker name.

## 9. What the CMS does not include

No newsletter module (sign-up forms, bot checks, email sending), no analytics tags, and no event or ticketing blocks. Add them as new modules if a project needs them.

## 10. No pull request previews

Per-PR previews are not part of this repo: a preview would need its own KV namespaces and R2 bucket as well as a D1 database. They could be added as a follow-up.

## 11. Home page

The CMS owns `/`. With nothing published, `/` shows a generic "Nothing published yet. Sign in to /admin and import the starter content." page. `/admin/setup` ("Import starter content") creates the sample pages, posts, nav, footer and swatches as drafts; nothing is public until published. `bun run seed` (in `apps/web`) does the same against the local database.

## 12. Design knobs

Design lives in known files only: fonts and `@theme` tokens in `apps/web/src/styles.css`, `BRAND_TOKENS` and gradients in the cms-core style vars, swatches in the site defaults, `og-card.tsx`, and the logo and favicon in `public/`. `docs/design.md` lists them and the `restyle` skill tells agents how to change them.

## 13. Code style

Biome/ultracite strict, no `any`, `type` aliases in CMS code, `nanoid` for client ids, in-app dialogs (never `window.confirm`/`prompt`/`alert`).
