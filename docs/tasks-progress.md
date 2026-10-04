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
| [x] | Gate: package tests and typecheck pass | final run: `packages/db` `bun test` 56 pass, 0 fail (9 files); `packages/cms-core` 515 pass, 0 fail (42 files); `bun run check`: `Tasks: 5 successful, 5 total` (typecheck of every workspace) |

## Phase 2: Services

| Done | Item | Proof |
| --- | --- | --- |
| [x] | pages, site, posts, history, preview, render tokens, publish (2A) | `packages/services`: `bun test` 238 pass, 0 fail (15 files; pages-service, history-admin, site-service, read-page, pages-index, render-token, preview-link, posts, `loadCmsPage` and the bound factories against the real `@repo/db` modules); `bunx tsc --noEmit` clean (incl. `ports.typecheck.ts`: each db factory satisfies its port); `bunx ultracite check packages/services` clean; `rg -l "cloudflare:workers\|from "react"\|apps/web" packages/services/src` empty; brand grep over `packages/services` empty |
| [x] | media, api keys, MCP calls, OAuth connections (2A) | same run: media-service/media-bytes tests, `mcp/keys` (`cms_live_`/`cms_dev_`, hashing, 90-day prune) and `mcp/connections` (grant revoke through the `OAuthGrants` port) on `createTestDb()`; media-usage SQL stays covered by `@repo/db` `media-usage.test.ts` |
| [x] | agent runs, Search Console sync (2B) | `packages/services/src/agent`: `AgentStore` port (`store-port.ts`, checked against `createD1AgentStore` in `store-port.typecheck.ts`), `ModelProvider` port with the Anthropic and Workers AI providers, provider-agnostic loop, tool executors over cms-core, run orchestration and the admin functions as plain services (`admin-service.ts`); 127 tests (loop, runs, workers-ai, limits, alt-text, render-auth, admin service, models); `src/gsc`: client, sync, cron, admin calls with injected fetch/store/config; purity grep and brand grep over both paths empty; `bunx ultracite check packages/services/src/agent packages/services/src/gsc` clean; time zone is a `timeZone` parameter (default UTC) |
| [x] | Gate: `bun test` in `packages/services` | final run: 434 pass, 0 fail (28 files) |

## Phase 3: Web

| Done | Item | Proof |
| --- | --- | --- |
| [x] | Phase 3A: server side of `apps/web` (wiring, 11 CMS tRPC routers under `cms.*`, adapters, raw routes, MCP + OAuth, CSRF, login redirect, auth-redirect helper). Agent and Search Console routers, `admin.api.agent`, `og-render-agent`, GSC cron and 17 agent-backed MCP tools are stubbed with `TODO(cms-port-agent)` for the next phase | `apps/web`: `bunx tsc --noEmit` clean; `bun test` 175 pass, 0 fail; `bunx ultracite check` clean on server, lib, routes, integrations; `bun run build` ok and `grep -rli drizzle apps/web/dist/client` empty; dev with `CF_REMOTE_BINDINGS=0` (dummy Clerk keys in the gitignored `.env.local`): `/api/health`, `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/llms-full.txt` 200, `/media/x` 404, `/mcp` 401, anonymous `cms.pages.listPages` 401, anonymous upload 401; brand grep over `apps/web/src` empty. Details: scratchpad `report-3a.md` |
| [x] | Phase 3B: blocks (14) + registry, renderer, editor, admin UI, site editor, public routes on `getTrpc()` | `apps/web`: `bunx tsc --noEmit` 0 errors; `bun test` 437 pass, 0 fail (54 files); `bunx ultracite check apps/web/src/modules apps/web/src/components apps/web/src/routes` clean; brand grep over UI paths empty |
| [x] | Agent UI (panel, runs page, SSE reader), Search Console UI (`/admin/seo`, performance panel, opportunities) | same run; agent and `cms.gsc` calls typed against the routers. The Search Console backfill card on `/admin/setup` was restored in the fix round (commit 8feb634), gated on `planGscBackfill.configured` |
| [x] | Gate: typecheck, build, `grep -r drizzle apps/web/dist/client` empty, `bun test` | final run: `apps/web` `bunx tsc --noEmit` clean; `bun run build` `built in 1.18s`; `grep -rIl drizzle apps/web/dist/client` empty; `bun test` 438 pass, 0 fail |

## Phase 4: Design and content

| Done | Item | Proof |
| --- | --- | --- |
| [x] | Neutral SaaS theme (white/zinc, Inter, indigo accent, dark mode), generic header, footer and home fallback | commit f6f6bac: brand tokens moved to `--color-brand-*`, border `cyber` renamed `glow`, admin on theme tokens, logo, favicon, share card; `apps/web`: `bunx tsc --noEmit` clean, `bun test` 433 pass; `bun run test` 4 tasks pass; `bun run build` ok, `grep -rIl drizzle dist/client` empty; `bunx ultracite check` clean; screenshots of home (light, dark, 390px), about, pricing, blog, post, `/admin/pages` and the editor checked in a headless browser |
| [x] | Seed content: Home, About, Pricing, Contact, 3 blog posts, nav, footer, swatches | commit fee8f15: `starter-content.ts` builders, `importStarterContent` service and `cms.setup.importStarterContent` button on `/admin/setup`, `bun run seed`; run twice against local D1: second run skips all 7 pages; cms-core 512 and services 431 tests pass |
| [x] | `docs/design.md` and the `restyle` skill | `docs/design.md` and `.claude/skills/restyle/SKILL.md` written; steps in both were run during this phase |

## Phase 5: Skills and docs

| Done | Item | Proof |
| --- | --- | --- |
| [x] | `project-init`, `setup-cloudflare` (D1, 2 KV, R2, secrets), `rename-project` (resource names, MCP prefix, `SITE_NAME`) | `rename.ts` run on a scratch worktree twice (`boilerplate` to `acme-site` to `other-name`): Worker name, D1 and R2 names, `SITE_NAME`, `.cta.json`, README headings, lockfile rewritten, `bun install --frozen-lockfile` in sync; `env.ts` commands (`status`, `database`, `kv`, `var`, `set ADMIN_EMAILS`, `signing-key`, `secrets-file`) run on the same copy, `signing-key` keeps an existing key; `bunx ultracite check` clean on both scripts. The wrangler create and deploy steps were not run against a real account |
| [x] | README, CLAUDE.md, AGENTS.md, CMS docs (go-live, MCP) | `README.md`, `AGENTS.md` (`CLAUDE.md` imports it), `docs/cms.md`, `docs/cms-go-live.md`, `docs/architecture.md`, `apps/web/README.md`, `packages/services/README.md`; brand grep over these files empty; `docs/image.png` removed (nothing referenced it) |
| [x] | Resolve every cms-port TODO marker outside `apps/web/src` and `packages/*/src` | the brief's gate (`rg` for the marker, excluding those two trees) returns nothing. The markers left in `apps/web/src` (the starter content list in `server/cms/doc-import.ts`, the setup route) belong to Phase 4 |

## Phase 6: Verify

| Done | Item | Proof |
| --- | --- | --- |
| [x] | Adversarial code review and fixes | review: scratchpad `review-port.md` (one medium, three low, one info finding) plus the open fix list F1-F13; every item fixed and marked DONE with its commit in scratchpad `decisions.md` (commits 9c41975, 8feb634, b55ea8e and the fixes after them); new tests: tRPC procedure guard (`server/trpc/guard.test.ts`), cron prune without `SITE_ORIGIN`, agent body cap, starter import on an http origin and validated before writing |
| [x] | Browser test: dev login, `/admin`, import starter content, edit, upload image, publish, view page, blog, MCP key and a `claude mcp` call | headless browser run against the dev server (scratchpad `ui-test/report.md`, with a re-test section after the fixes): steps 1-14 pass (dev login, import, edit, add block, reorder, undo, media upload, preview, publish, SEO and share image, site settings, posts, MCP key with `initialize`, `tools/list`, `tools/call`, scope refusal, revoke, dark mode, 390px, sign-out redirect); defects D1-D4 and D6 fixed, D5 (Style sub-tab jumping back once) not reproducible from the code. **Not browser-tested:** the OAuth connector flow, restore and rollback of a revision, unpublish, named versions, a real agent run (no `ANTHROPIC_API_KEY` locally), Search Console sync (not connected locally) |
| [x] | Brand grep gate: `grep -riE "harbour|hei\b|het_|het-cms|harbouredge|workshop|luma"` returns nothing | `git grep -niE "harbour\|\bhei\b\|het_\|harbouredge\|workshop\|luma\|dominik" -- . ":!bun.lock" ":!docs/tasks-progress.md"` returns only `LICENSE:3` (the copyright line, kept on purpose); the brand guard test in `cms-core/src/agent/prompt.test.ts` builds its words from pieces |
| [x] | Final commit | the commit that adds this row; clean `git status`, `bun install --frozen-lockfile` (`Checked 846 installs ... (no changes)`), `bun run check` (5 of 5), `bun run test` (4 of 4), `bun run build` all pass on that tree |
| [ ] | **Open:** real Cloudflare deploy (`setup-cloudflare` create and deploy steps, remote D1 migrations, custom domain) | not run: no Cloudflare account was used. `docs/cms-go-live.md` lists the steps |
