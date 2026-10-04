# Tasks and progress

One row per item of the build. Tick a row only with proof: the command that was run and its result. Design decisions are in `architecture.md`.

## Phase 0: Scaffold

| Done | Item | Proof |
| --- | --- | --- |
| [x] | Copy the melb template with `git archive`, `git init -b main`, workspace stays `boilerplate` | first commit `Import melb template unchanged`; `git log --oneline` |
| [x] | Clerk baked in (provider, login, dev-login, create-dev-user, Clerk-aware context, middleware in `server.ts` and `start.ts`, `clerk-skip.ts`) | `bun run check` passes; `bun test src/lib` covers `skipsClerk` (2 pass) |
| [x] | `add-clerk` skill and every "two copies of context.ts" rule removed; `project-init` always sets Clerk up | `grep -rIn "add-clerk\|two copies" .claude README.md CLAUDE.md apps packages` returns nothing |
| [x] | `notes` example removed (db module, service, router, route, migration, tests, docs) | `bun run test`: 4 workspaces pass; `grep -rIni notes README.md CLAUDE.md apps/web/src packages` returns nothing |
| [x] | PR previews removed (`setup-previews`, `preview.yml`, `preview.ts`, `env.staging`, scripts, docs) | `grep -rIni "staging\|setup-previews" . --exclude-dir=node_modules --exclude=bun.lock` returns only this row |
| [x] | `packages/cms-core` (`@repo/cms-core`) with exports map, tsconfig, `version.ts` and test, wired as a workspace | `bun run test`: `@repo/cms-core:test` 1 pass; `bun run check`: typecheck of 5 tasks passes |
| [x] | drizzle-orm `^0.45.3`, drizzle-kit `^0.31.11` everywhere | `grep -rn drizzle apps/web/package.json packages/*/package.json` |
| [x] | CMS dependencies added to `apps/web` (Anthropic SDK, OAuth provider, dnd-kit, MCP server, tiptap, agents, nanoid, zod, framer-motion, superjson, puppeteer dev) | `bun install` clean; `bun run build` succeeds |
| [x] | superjson on `initTRPC` and both client links; `adminProcedure` before input parsing | `bun run test`: `init.test.ts` 5 pass (admin, off-list, empty list, anonymous, rejected before input parsing) |
| [x] | `wrangler.jsonc`: `DB`, `CMS_PAGES`, `OAUTH_KV`, `CMS_MEDIA`, `AI`, `BROWSER`, cron, vars, flags, `workers_dev` | `CF_REMOTE_BINDINGS=0 bun run dev` reaches "ready"; `curl localhost:3000/api/health` returns `{"status":"ok"}` |
| [x] | `env.d.ts` declares every secret on `Cloudflare.Env` and `Env`; `.env.example` documents each; `cf-typegen` run | `bun run check` passes on a checkout where typegen sees the names |
| [x] | `docs/architecture.md` and this file | committed |
| [x] | Gates: `bun install`, `bun run check`, `bun run test`, `bun run build`, dev boot | `bun install`: `Checked 846 installs ... (no changes)`; `bun run check`: `Tasks: 5 successful, 5 total`; `bun run test`: 7 web + 1 db + 1 services + 1 cms-core pass, 0 fail; `bun run build`: `built in 453ms`; dev boot: `VITE ready`, `/api/health` `{"status":"ok"}` |

## Phase 1: Foundations

| Done | Item | Proof |
| --- | --- | --- |
| [x] | `@repo/cms-core`: PageDoc types, ops engine, paths, reserved slugs, site doc schema, style vars, richtext helpers, limits, safe-href, format-date, pure llms/sitemap builders | `packages/cms-core`: `bun test` 479 pass, 0 fail (35 files); `bunx tsc --noEmit` clean; `bunx ultracite check packages/cms-core` clean; purity grep `grep -rlE 'from "react"\|drizzle\|cloudflare:workers\|@tanstack' src` empty; brand grep `grep -rniE "harbour\|\bhei\b\|het_\|het-cms\|harbouredge\|workshop\|luma"` empty; 14 block defs (`blocks/<name>.ts`, icon as string key) + `blocks/registry.ts`, `validate.ts`, seo checks and agent stage/catalogue/prompt are pure; `exports` is `"./*": "./src/*.ts"` |
| [x] | `@repo/db`: schema for every CMS table, one `0000_cms` migration | 19 tables in `packages/db/src/schema.ts`; `bun run generate -- --name cms` wrote `migrations/0000_cms.sql`; loaded next to the source repo's three migrations in `bun:sqlite`, tables, columns, defaults, pks, fks, indexes (incl. the partial unique `pages_slug_unique`) and `mcp_calls` AUTOINCREMENT are identical; `wrangler d1 migrations apply DB --local` from `apps/web`: `41 commands executed successfully`, `0000_cms.sql ✅` |
| [x] | `@repo/db`: table modules (pages, media, api keys, MCP calls, OAuth connections, agent threads/runs/changesets, Search Console) with tests | `packages/db`: `bun test` 56 pass, 0 fail (9 files; compare-and-set guards, `ChangesetDecided`, batch rollback and the turn lock run on a D1-shaped `bun:sqlite` stand-in); `bunx tsc --noEmit` clean; `bunx ultracite check packages/db` clean; brand grep over `packages/db` empty |
| [ ] | Gate: package tests and typecheck pass | |

## Phase 2: Services

| Done | Item | Proof |
| --- | --- | --- |
| [x] | pages, site, posts, history, preview, render tokens, publish (2A) | `packages/services`: `bun test` 238 pass, 0 fail (15 files; pages-service, history-admin, site-service, read-page, pages-index, render-token, preview-link, posts, `loadCmsPage` and the bound factories against the real `@repo/db` modules); `bunx tsc --noEmit` clean (incl. `ports.typecheck.ts`: each db factory satisfies its port); `bunx ultracite check packages/services` clean; `rg -l "cloudflare:workers\|from "react"\|apps/web" packages/services/src` empty; brand grep over `packages/services` empty |
| [x] | media, api keys, MCP calls, OAuth connections (2A) | same run: media-service/media-bytes tests, `mcp/keys` (`cms_live_`/`cms_dev_`, hashing, 90-day prune) and `mcp/connections` (grant revoke through the `OAuthGrants` port) on `createTestDb()`; media-usage SQL stays covered by `@repo/db` `media-usage.test.ts` |
| [x] | agent runs, Search Console sync (2B) | `packages/services/src/agent`: `AgentStore` port (`store-port.ts`, checked against `createD1AgentStore` in `store-port.typecheck.ts`), `ModelProvider` port with the Anthropic and Workers AI providers, provider-agnostic loop, tool executors over cms-core, run orchestration and the admin functions as plain services (`admin-service.ts`); 127 tests (loop, runs, workers-ai, limits, alt-text, render-auth, admin service, models); `src/gsc`: client, sync, cron, admin calls with injected fetch/store/config; purity grep and brand grep over both paths empty; `bunx ultracite check packages/services/src/agent packages/services/src/gsc` clean; time zone is a `timeZone` parameter (default UTC) |
| [ ] | Gate: `bun test` in `packages/services` | |

## Phase 3: Web

| Done | Item | Proof |
| --- | --- | --- |
| [x] | Phase 3A: server side of `apps/web` (wiring, 11 CMS tRPC routers under `cms.*`, adapters, raw routes, MCP + OAuth, CSRF, login redirect, auth-redirect helper). Agent and Search Console routers, `admin.api.agent`, `og-render-agent`, GSC cron and 17 agent-backed MCP tools are stubbed with `TODO(cms-port-agent)` for the next phase | `apps/web`: `bunx tsc --noEmit` clean; `bun test` 175 pass, 0 fail; `bunx ultracite check` clean on server, lib, routes, integrations; `bun run build` ok and `grep -rli drizzle apps/web/dist/client` empty; dev with `CF_REMOTE_BINDINGS=0` (dummy Clerk keys in the gitignored `.env.local`): `/api/health`, `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/llms-full.txt` 200, `/media/x` 404, `/mcp` 401, anonymous `cms.pages.listPages` 401, anonymous upload 401; brand grep over `apps/web/src` empty. Details: scratchpad `report-3a.md` |
| [x] | Phase 3B: blocks (14) + registry, renderer, editor, admin UI, site editor, public routes on `getTrpc()` | `apps/web`: `bunx tsc --noEmit` 0 errors; `bun test` 437 pass, 0 fail (54 files); `bunx ultracite check apps/web/src/modules apps/web/src/components apps/web/src/routes` clean; brand grep over UI paths empty |
| [x] | Agent UI (panel, runs page, SSE reader), Search Console UI (`/admin/seo`, performance panel, opportunities) | same run; agent and `cms.gsc` calls typed against the routers. Open: Search Console backfill card on `/admin/setup` (`TODO(cms-port-agent)`) |
| [ ] | Gate: typecheck, build, `grep -r drizzle apps/web/dist/client` empty, `bun test` | |

## Phase 4: Design and content

| Done | Item | Proof |
| --- | --- | --- |
| [ ] | Neutral SaaS theme (white/zinc, Inter, indigo accent, dark mode), generic header, footer and home fallback | |
| [ ] | Seed content: Home, About, Pricing, Contact, 3 blog posts, nav, footer, swatches | |
| [ ] | `docs/design.md` and the `restyle` skill | |

## Phase 5: Skills and docs

| Done | Item | Proof |
| --- | --- | --- |
| [ ] | `project-init`, `setup-cloudflare` (D1, 2 KV, R2, secrets), `rename-project` (resource names, MCP prefix, `SITE_NAME`) | |
| [ ] | README, CLAUDE.md, AGENTS.md, CMS docs (go-live, MCP) | |
| [ ] | Resolve every `TODO(cms-port)` | `grep -rn "TODO(cms-port)" .` returns nothing |

## Phase 6: Verify

| Done | Item | Proof |
| --- | --- | --- |
| [ ] | Adversarial code review and fixes | |
| [ ] | Browser test: dev login, `/admin`, import starter content, edit, upload image, publish, view page, blog, MCP key and a `claude mcp` call | |
| [ ] | Brand grep gate: `grep -riE "harbour|hei\b|het_|het-cms|harbouredge|workshop|luma"` returns nothing | |
| [ ] | Final commit | |
