# Boilerplate

A starter for a website with a built-in CMS, on [Cloudflare](https://developers.cloudflare.com) Workers. You edit pages and blog posts in an in-browser editor, publish them, and an AI agent and an MCP server can edit alongside you. There is no separate CMS service to run: the CMS is part of the app.

It is a [Turborepo](https://turborepo.com) monorepo managed with [Bun](https://bun.sh) workspaces. The web app is [TanStack Start](https://tanstack.com/start) on Vite, served by [Hono](https://hono.dev). Auth is [Clerk](https://clerk.com).

## What you get

- Pages built from 14 blocks (hero, feature grid, pricing, FAQ, call to action, stats, steps, testimonial, logos, image, rich text, callout, checklist, post list), edited on a live canvas with an inspector, layers, undo and a style panel.
- Draft and publish. Publishing writes a snapshot to KV, so public pages are served without touching the database. Revision history, named versions, restore, rollback and signed preview links.
- An SEO tab per page (title and description pixel widths, checks, structured data), generated share images, `sitemap.xml`, `llms.txt`, `llms-full.txt` and `robots.txt`.
- Site settings: navigation, footer, color swatches, default SEO.
- A blog with a post list block and an index page.
- Media library on R2, with upload, alt text and "used on" tracking.
- An AI page agent that proposes changes you accept or reject, plus site-wide runs with spending caps. Claude through an API key, or Workers AI.
- Search Console sync with a per-page performance view and SEO opportunities.
- An MCP server at `/mcp`, with API keys and OAuth sign-in, so Claude Code and Claude.ai can read and edit the site.
- Starter design: neutral white and zinc, Inter, an indigo accent, dark mode. See [docs/design.md](docs/design.md) to change it.

## Quick start (local)

You need [Bun](https://bun.sh) 1.3 or newer and a free [Clerk](https://clerk.com) application. No Cloudflare account is needed to develop.

```bash
bun install
cp apps/web/.env.example apps/web/.env.local
```

Fill in `apps/web/.env.local`: the three Clerk keys, `ADMIN_EMAILS` (your email), `PREVIEW_SIGNING_KEY` (at least 32 characters; generate one with `openssl rand -base64 32`), and for the one-click dev login `DEV_LOGIN_EMAIL` and `DEV_LOGIN_PASSWORD`. Without Clerk keys the pages fail with a server error; only `/api/health` answers.

```bash
cd apps/web
bun run create-dev-user
CF_REMOTE_BINDINGS=0 bun run dev
```

Open <http://localhost:3000/login> and use "Dev login (local only)", then go to `/admin`. Open `/admin/setup` and click "Import starter content". One click creates and publishes the sample pages, posts, menu and footer; pages that already exist are skipped, so it is safe to run again. Edit them in the editor and publish your changes. From `apps/web`, `bun run seed` runs the same import against the local database without the browser (run `bun run dev` once first, so the migrations are applied).

`bun run dev` applies the D1 migrations to a local database first. The local database, KV and R2 are simulated by Miniflare under `apps/web/.wrangler`; delete that folder for a clean slate. `CF_REMOTE_BINDINGS=0` skips the one remote binding (Workers AI) so dev starts without a Cloudflare login; the agent then offers Claude models only, and those need `ANTHROPIC_API_KEY`.

## Deploy

You need [Claude Code](https://claude.com/claude-code) and a free Cloudflare account. Start Claude Code in the repo and type `/project-init`. It:

1. asks for a name and renames the project,
2. connects your Clerk application,
3. signs you in to Cloudflare, creates the D1 database, two KV namespaces and the R2 bucket, sets the secrets and the `SITE_*` vars, applies the migrations and deploys,
4. tells you to open `/admin` on the new `workers.dev` URL and import the starter content.

It asks before creating anything on your account, and it is safe to run again. Afterwards, commit the resource ids it wrote to `apps/web/wrangler.jsonc`.

Without Claude Code, `bun .claude/skills/rename-project/rename.ts my-app` does the rename, and `.claude/skills/setup-cloudflare/SKILL.md` lists the wrangler steps in order. Before the site goes public, work through [docs/cms-go-live.md](docs/cms-go-live.md).

Later deploys, from `apps/web`: `bun run deploy` builds, applies pending D1 migrations to the remote database and deploys.

## Layout

```
apps/web            TanStack Start app, Hono server, tRPC routers, adapters, the CMS UI
packages/cms-core   pure, isomorphic code: page documents, block definitions, ops engine, SEO checks
packages/db         Drizzle schema, the migration, D1 table modules
packages/services   business rules, written against ports (repos, KV, R2, AI providers)
docs/               architecture, how the CMS works, go-live checklist, design
.claude/skills/     project-init, setup-cloudflare, rename-project, restyle
```

A request goes route, then tRPC router, then service, then table module. See [docs/architecture.md](docs/architecture.md).

## Commands

At the root, through Turborepo:

- `bun run dev`, `bun run build`, `bun run preview`, `bun run deploy`
- `bun run test` runs every workspace's tests
- `bun run check` and `bun run fix` lint and format with [Ultracite](https://ultracite.ai), and `check` also typechecks

In `apps/web`: `bun run create-dev-user`, `bun run seed`, `bun run gsc:auth`, `gsc:backfill` and `gsc:sync` (Search Console). In `packages/db`: `bun run generate` after a schema change.

## Docs

- [docs/cms.md](docs/cms.md): how the CMS works, for the people using it
- [docs/cms-go-live.md](docs/cms-go-live.md): the checklist before going public
- [docs/architecture.md](docs/architecture.md): the fixed design decisions
- [docs/design.md](docs/design.md): where the look lives and how to change it
- [apps/web/README.md](apps/web/README.md), and one README per package

## Not included

Pull request previews. Each preview would need its own D1 database, KV namespaces and R2 bucket, so it was left out. It is a possible follow-up.

## License

[MIT](LICENSE)
