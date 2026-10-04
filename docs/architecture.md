# Architecture

The decisions below are fixed. Change one only on purpose, and update this file in the same commit.

The repo is a Turborepo (Bun workspaces): `apps/web` (TanStack Start on Vite, served by Hono on Cloudflare Workers), `packages/cms-core`, `packages/db`, `packages/services`. It holds a built-in CMS: core blocks, an iframe editor, publish to KV, previews, an SEO tab, share images, sitemap and llms.txt, site settings (nav, footer, swatches), a blog, R2 media, an MCP server with API keys and OAuth, an AI page agent with site-wide runs, and Search Console sync.

## 1. Packages

- `@repo/cms-core` (`packages/cms-core`): isomorphic pure code. PageDoc types, ops engine, paths, reserved slugs, site doc schema, style vars, richtext helpers, limits, safe-href, format-date, llms/sitemap builders if pure. No drizzle, no React, no Cloudflare. One `exports` entry per module, no barrel.
- `@repo/db` (`packages/db`): the Drizzle schema for every CMS table, one migration generated from the whole schema (`0000_cms`), and the table modules (pages, media, api keys, MCP calls, OAuth connections, agent threads/runs/changesets, Search Console tables). `shared.ts` holds browser-safe types and constants. The D1 table modules use `db.batch` for atomic compare-and-set, so they take a `DrizzleD1Database`, not the generic `Database` type. Services are unit-tested against in-memory fakes of the repo ports; D1 modules get their own tests where `bun:sqlite` can stand in, otherwise via miniflare/local D1.
- `@repo/services` (`packages/services`): business rules. Factories that take ports: repos, a KV-like port, an R2-like port, `validate`/`labelFor` functions, AI/Anthropic provider ports, a clock. They never read `env` and never import `cloudflare:workers`. Pages, site, posts, history, preview, render tokens, publish, media, API keys, Search Console sync, agent run orchestration.
- `apps/web/src/server/adapters/`: the Cloudflare implementations of the ports (KV, R2, Workers AI, Browser Run, Anthropic SDK). `apps/web/src/server/trpc/context.ts` wires them from `env`.
- `apps/web/src/modules/cms/`: blocks (zod schema and React component stay together; `validate` is injected into services), editor, renderer, admin UI, agent UI, MCP tool definitions.

## 2. RPC

tRPC carries every browser-to-server call. `superjson` is the transformer on `initTRPC` and on both client links (`apps/web/src/integrations/trpc/client.ts`), because results contain `Date`s. These stay as Hono or TanStack server routes, not tRPC: multipart media upload (`admin.api.media`), the agent stream (`admin.api.agent`), `/mcp` and the OAuth endpoints, `/media/:id`, `og-render*`, sitemap, llms, robots, and `oauth.authorize`.

## 3. Admin gate

`adminProcedure = protectedProcedure.use(...)` in `apps/web/src/server/trpc/init.ts`. Admins come from the `ADMIN_EMAILS` secret: comma-separated, trimmed, case-insensitive, matched against the signed-in Clerk user's verified email addresses. It fails closed: an empty list, missing Clerk keys or an unverified address mean no admin. Anonymous callers get UNAUTHORIZED, signed-in non-admins FORBIDDEN.

`context.ts` carries what the check needs: `ctx.adminEmails` (the parsed allowlist) and `ctx.auth.verifiedEmails()`, a lazy lookup of the user's verified addresses through Clerk's backend API, memoised per request so ordinary procedures never pay for it. Routers call `.input()` after `adminProcedure`, so admin is asserted before input parsing (tRPC runs middleware first). `init.test.ts` covers this.

## 4. Clerk is mandatory

The admin area needs it. The provider, `/login`, `/dev-login`, `create-dev-user` and the Clerk-aware tRPC context are part of the code. Clerk's middleware runs in both layers (the Hono app in `server.ts`, Start's request middleware in `start.ts`), except for the cookieless public paths in `src/lib/clerk-skip.ts`. `/api/health` is registered before the middleware, so it answers without Clerk keys. `/project-init` always sets Clerk up.

## 5. Examples in the docs

The READMEs use the CMS table modules as the examples. There is no sample `notes` table.

## 6. Bindings

`apps/web/wrangler.jsonc`, each commented there:

| Binding | Kind | Used for |
| --- | --- | --- |
| `DB` | D1 (`<project>-cms`) | all CMS data; migrations in `packages/db/migrations` |
| `CMS_PAGES` | KV | published page snapshots |
| `OAUTH_KV` | KV | MCP OAuth clients, grants and tokens |
| `CMS_MEDIA` | R2 (`<project>-cms-media`) | uploaded media |
| `AI` | Workers AI (`remote: true`) | the page agent's second provider |
| `BROWSER` | Browser Run | share images, agent render target |

Cron `0 18 * * *` runs the Search Console sync. `workers_dev` is `true`, so a deploy ends on a workers.dev URL; MCP OAuth tokens are bound to the host that issued them, so a later move to a custom domain means re-authorising MCP clients. The compatibility flags are `nodejs_compat` and `global_fetch_strictly_public` (the OAuth provider needs the latter).

Vars: `SITE_NAME`, `SITE_ORIGIN`, `GSC_PROPERTY` (optional). Secrets: the Clerk keys, `ADMIN_EMAILS`, `PREVIEW_SIGNING_KEY`, `ANTHROPIC_API_KEY` (optional), `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` (optional). Every secret is declared in `apps/web/src/env.d.ts` on both `Cloudflare.Env` and `Env`, so a checkout without `.env.local` typechecks.

## 7. Generic names

MCP key prefixes are `cms_live_` and `cms_dev_`; the MCP server name comes from the `SITE_NAME` slug. Resource names are `<project>-cms-*`, rewritten by `rename-project`.

## 8. What the CMS does not include

Event-site content (event pages, event blocks, ticketing embeds), a newsletter module (sign-up forms, Turnstile, email, the signup Workflow), heartbeat pings, GTM analytics, legacy redirects, and the `SUBSCRIBERS` and `SIGNUP_FAILURES` KV namespaces.

## 9. No pull request previews

Per-PR previews are not part of this repo: a preview would need its own KV namespaces and R2 bucket as well as a D1 database. They could be added as a follow-up.

## 10. Home page

The CMS owns `/`. With nothing published, `/` shows a generic "Nothing published yet. Sign in to /admin and import the starter content." page. `/admin/setup` ("Import starter content") and `bun run seed` (local D1/KV) create the sample pages, posts, nav, footer and swatches.

## 11. Design knobs

Design lives in known files only: fonts and `@theme` tokens in `apps/web/src/styles.css`, `BRAND_TOKENS` and gradients in the cms-core style vars, swatches in the site defaults, `og-card.tsx`, and the logo and favicon in `public/`. `docs/design.md` lists them and the `restyle` skill tells agents how to change them (TODO(cms-port): both arrive in phase 4).

## 12. Code style

Biome/ultracite strict, no `any`, `type` aliases in CMS code, `nanoid` for client ids, in-app dialogs (never `window.confirm`/`prompt`/`alert`).
