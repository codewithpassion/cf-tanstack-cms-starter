# Boilerplate

A [Turborepo](https://turborepo.com) monorepo, managed with Bun workspaces.

## Apps

- [`apps/web`](apps/web) — the [TanStack Start](https://tanstack.com/start) front end, deployed on Cloudflare Workers, with [Cloudflare D1](https://developers.cloudflare.com/d1/) for data. See its [README](apps/web/README.md) for architecture and setup.

Auth is [Clerk](https://clerk.com): `/login` signs in, the header shows the signed-in user. `/admin` is limited to the emails in `ADMIN_EMAILS`.

## Packages

- [`packages/db`](packages/db) — `@repo/db`: the Drizzle schema for D1, the generated migrations, and the table modules. See its [README](packages/db/README.md).
- [`packages/cms-core`](packages/cms-core) — `@repo/cms-core`: isomorphic, pure CMS code (page documents, ops engine, paths). No drizzle, no React, no Cloudflare.
- [`packages/services`](packages/services) — `@repo/services`: the service layer. Business rules and validation, on top of `@repo/db`. The web app calls it through [tRPC](https://trpc.io). See its [README](packages/services/README.md).

## Start a new project

You need [Bun](https://bun.sh) 1.3 or newer and [Claude Code](https://claude.com/claude-code). Deploying also needs a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

1. Create your repo from the template and clone it. This makes a new private GitHub repo with a fresh history:

   ```bash
   gh repo create my-app --template codewithpassion/cf-tanstack-boilerplate --private --clone
   cd my-app
   bun install
   ```

   Without the `gh` CLI, press "Use this template" on the [template's GitHub page](https://github.com/codewithpassion/cf-tanstack-boilerplate) and clone the repo it creates.

2. Start Claude Code in that folder and type `/project-init`. It asks for a name, renames the project to it and commits. It connects your Clerk application, then signs you in to Cloudflare, creates the D1 database, applies the migrations and does the first deploy. It asks before creating anything on your account. When it finishes you have a `https://my-app.<subdomain>.workers.dev` URL. Open `/api/health` on it to check the Worker is up.

3. Commit what `/project-init` left uncommitted and push. That includes the D1 `database_id` in `apps/web/wrangler.jsonc`. It is not a secret, and without it a fresh clone deploys against the `"local"` placeholder.

After that, deploying is two commands from `apps/web`. Run the first one only when `packages/db` has a new migration:

```bash
bunx wrangler d1 migrations apply DB --remote
bun run deploy
```

No Claude Code? `bun .claude/skills/rename-project/rename.ts my-app` does the rename, and [Deploy](#deploy) below has the Cloudflare steps by hand.

## Develop

```bash
bun install
bun run dev
```

`bun run dev` applies the D1 migrations to a local database and starts the web app. The local database is SQLite, run by [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/) under the Cloudflare Vite plugin, and lives in `apps/web/.wrangler`. No account and no Docker needed.

Commands at the root run across all apps via [Turborepo](https://turborepo.com):

- `bun run dev` — start all apps in dev mode
- `bun run build` — build all apps
- `bun run deploy` — build and deploy all apps
- `bun run preview` — preview production builds
- `bun run check` / `bun run fix` — lint/format the whole repo with [Ultracite](https://ultracite.ai)
- `bun run test` — run every workspace's tests

To run a command for a single app, use turbo's filter flag, e.g. `bunx turbo run dev --filter=web`, or `cd apps/web && bun run dev`.

## Deploy

Local development needs none of this. You only need the accounts below when you want the app running on the internet.

### 1. A Cloudflare account

The web app deploys to [Cloudflare Workers](https://workers.cloudflare.com). The free plan is enough. Sign in once from the terminal:

```bash
cd apps/web
bunx wrangler login
```

If you belong to more than one Cloudflare account, `wrangler deploy` will ask which one to use; set `CLOUDFLARE_ACCOUNT_ID` in `apps/web/.env.local` to skip the prompt. The Worker's name comes from `apps/web/wrangler.jsonc` (the `rename-project` skill sets it).

### 2. A D1 database

The local database only exists on your machine, so a deployed Worker needs a real [D1](https://developers.cloudflare.com/d1/) database. It is on the same free plan as the Worker:

```bash
cd apps/web
bunx wrangler d1 create boilerplate
```

That prints a `database_id`. Put it in the `d1_databases` entry in `apps/web/wrangler.jsonc`, replacing the `"local"` placeholder, then create the tables:

```bash
bunx wrangler d1 migrations apply DB --remote
```

Repeat the `migrations apply --remote` whenever `packages/db` gains a new migration.

### 3. Ship it

```bash
bun run deploy
```

That builds and runs `wrangler deploy`. The URL is printed at the end; open `/api/health` on it to confirm the Worker is up.

## Pull request previews

Per-PR previews are not part of this starter. TODO(cms-port): say here that they could be added as a follow-up (each preview would need its own KV namespaces and R2 bucket as well as a D1 database).

## License

[MIT](LICENSE)
