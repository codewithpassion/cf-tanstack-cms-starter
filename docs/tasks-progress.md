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
| [ ] | `@repo/cms-core`: PageDoc types, ops engine, paths, reserved slugs, site doc schema, style vars, richtext helpers, limits, safe-href, format-date, pure llms/sitemap builders | |
| [ ] | `@repo/db`: schema for every CMS table, one `0000_cms` migration | |
| [ ] | `@repo/db`: table modules (pages, media, api keys, MCP calls, OAuth connections, agent threads/runs/changesets, Search Console) with tests | |
| [ ] | Gate: package tests and typecheck pass | |

## Phase 2: Services

| Done | Item | Proof |
| --- | --- | --- |
| [ ] | pages, site, posts, history, preview, render tokens, publish | |
| [ ] | media, api keys, MCP calls, OAuth connections | |
| [ ] | agent runs, Search Console sync | |
| [ ] | Gate: `bun test` in `packages/services` | |

## Phase 3: Web

| Done | Item | Proof |
| --- | --- | --- |
| [ ] | tRPC routers, context, adapters, Hono/server routes (`router.ts`, `context.ts`, `server.ts`, `wrangler.jsonc`) | |
| [ ] | Blocks, renderer, editor, admin UI on `getTrpc()` | |
| [ ] | Agent UI, Search Console UI, MCP and OAuth | |
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
