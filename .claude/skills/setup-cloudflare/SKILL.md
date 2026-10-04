---
name: setup-cloudflare
description: Put the CMS on a Cloudflare account and do the first deploy - wrangler login, the D1 database, two KV namespaces and the R2 bucket, their ids in wrangler.jsonc, Worker secrets, the SITE_* vars, deploy, health check. Safe to re-run. Use when project-init reaches Cloudflare or the user asks for a first deploy.
allowed-tools: AskUserQuestion, Bash(bun:*), Bash(cp:*), Bash(curl:*), Bash(rm:*), Bash(git:*)
---

# Set up Cloudflare

Puts the Worker named in `apps/web/wrangler.jsonc` on the user's Cloudflare
account, with the resources it binds: D1 `<name>-cms`, KV `<name>-cms-pages`
and `<name>-cms-oauth`, R2 `<name>-cms-media`. Workers AI and Browser Run are
bindings only; they need nothing created. `<name>` is the `name` in
`wrangler.jsonc`.

The tracked file this touches is `wrangler.jsonc` (resource ids and the
`SITE_*` vars). Leave that change uncommitted and hand it back.

Run wrangler from the repo root as `bun x wrangler --cwd apps/web …`, so it
finds `wrangler.jsonc` and reads `apps/web/.env.local`. Change `.env.local` and
`wrangler.jsonc` only through `env.ts`; reading `.env.local` would put secrets
in the transcript. Local values never go in `.dev.vars`, only `.env.local`.

`vite build` leaves a copy of `wrangler.jsonc` in `apps/web/dist/server/` and a
redirect to it in `apps/web/.wrangler/deploy/`, and wrangler then reads the copy
instead of the source. A stale copy still has `local` ids and an empty
`SITE_ORIGIN`. So step 4 removes the redirect, and every deploy is preceded by a
fresh build.

Every step checks the current state first, so a re-run picks up where the last
one stopped. `bun .claude/skills/setup-cloudflare/env.ts status` lists what is
still unset (ids that are `local`, empty vars, which keys have a value, names
only).

## 1. Login

`bun x wrangler --cwd apps/web whoami`. Not logged in: the login is a browser
OAuth flow, so ask the user to run `! bun x wrangler login` and wait. If they
would rather not right now, stop and say so in the hand-back.

Done when `whoami` lists at least one account.

## 2. Account

One account listed: nothing to do. Several: ask with `AskUserQuestion` which
one, then

```bash
cp -n apps/web/.env.example apps/web/.env.local
bun .claude/skills/setup-cloudflare/env.ts account <account-id>
```

Wrangler reads `CLOUDFLARE_ACCOUNT_ID` from `.env.local` next to its config.

Done when `bun x wrangler --cwd apps/web secret list` either lists secrets or
says the Worker is not found. Both mean the account resolved; an account picker
error means it did not.

## 3. Ask

Run `env.ts status`. The Clerk keys must be `set`: if not, stop and send the
user back to the Clerk step of `project-init`.

Ask in one `AskUserQuestion` round, skipping what is already answered:

- "Create the D1 database, two KV namespaces and the R2 bucket named above, and
  deploy to Cloudflare now?" Say that the deploy creates a public `workers.dev`
  URL. No: stop and go to step 9.
- `ADMIN_EMAILS`, only if `status` says it is empty. Comma-separated emails that
  may use `/admin`; each must be verified on the Clerk account.
- The time zone for "today" (the date of a new post, the agent's daily budget
  day). Suggest `bun -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'`.
- The public address: the `workers.dev` URL (default, known only after the
  first deploy) or a custom domain the user already has on Cloudflare. MCP OAuth
  tokens are bound to the host that issued them, so moving to a custom domain
  later means reconnecting MCP clients.
- Optional: a Claude API key (`ANTHROPIC_API_KEY`) for the page agent. Without
  it the agent offers Workers AI models only. Search Console (`GSC_*`) can wait;
  `docs/cms-go-live.md` covers it. For either, tell the user to paste the value
  into `apps/web/.env.local` themselves.

Write the answers:

```bash
bun .claude/skills/setup-cloudflare/env.ts set ADMIN_EMAILS "a@example.com,b@example.com"
bun .claude/skills/setup-cloudflare/env.ts var SITE_TIME_ZONE Europe/Berlin
bun .claude/skills/setup-cloudflare/env.ts var SITE_ORIGIN https://example.com   # custom domain only
bun .claude/skills/setup-cloudflare/env.ts signing-key
```

`signing-key` writes `PREVIEW_SIGNING_KEY` (32 random bytes, base64url) only when
it is empty. Never regenerate it by hand on a re-run: a new key invalidates
every preview link.

## 4. Database

`<db>` is the `database_name` already in the `d1_databases` binding. First
remove any redirect left by an earlier build, so wrangler reads the source
config:

```bash
rm -rf apps/web/.wrangler/deploy
bun x wrangler --cwd apps/web d1 info <db> --json
```

It exists: take its uuid from the output. It does not:

```bash
bun x wrangler --cwd apps/web d1 create <db>
bun x wrangler --cwd apps/web d1 info <db> --json
bun .claude/skills/setup-cloudflare/env.ts database <uuid>
```

Done when `env.ts status` no longer says the D1 `database_id` is local.

## 5. KV namespaces

Two, by binding: `CMS_PAGES` is `<name>-cms-pages`, `OAUTH_KV` is
`<name>-cms-oauth`. Skip a binding whose id is no longer `local` in `status`.

```bash
bun x wrangler --cwd apps/web kv namespace list
bun x wrangler --cwd apps/web kv namespace create <name>-cms-pages
bun x wrangler --cwd apps/web kv namespace create <name>-cms-oauth
```

Create only the ones `list` does not show; the title is exactly the name you
pass. Take each id from the
`create` output (or the `list` entry) and record it:

```bash
bun .claude/skills/setup-cloudflare/env.ts kv CMS_PAGES <id>
bun .claude/skills/setup-cloudflare/env.ts kv OAUTH_KV <id>
```

Done when `status` reports no KV id as local.

## 6. R2 bucket

`<bucket>` is the `bucket_name` in the `r2_buckets` binding. Its id is its
name, so nothing goes in the file.

```bash
bun x wrangler --cwd apps/web r2 bucket list
bun x wrangler --cwd apps/web r2 bucket create <bucket>
```

Create it only if `list` does not show it. R2 has to be enabled on the account
first. If `create` fails with an error about R2 not being enabled, ask the user
to enable it in the Cloudflare dashboard (R2 Object Storage; it may ask for a
payment method), then re-run this step.

Done when `r2 bucket list` shows the bucket.

## 7. Migrations

```bash
bun x wrangler --cwd apps/web d1 migrations apply DB --remote
```

This creates the tables and has to run before the first request touches the
database. Done when it reports the migrations as applied (or nothing to apply).

## 8. Deploy

```bash
bun run --cwd apps/web build
bun .claude/skills/setup-cloudflare/env.ts secrets-file
bun x wrangler --cwd apps/web deploy --secrets-file <path it printed>
rm <path it printed>
```

`secrets-file` writes the Clerk keys, `ADMIN_EMAILS`, `PREVIEW_SIGNING_KEY` and
whichever of `ANTHROPIC_API_KEY` and `GSC_*` have a value, and prints the path
plus the key names. It never includes `DEV_LOGIN_*` or the account id. The
secrets ride along with the deploy because `wrangler secret put` needs a Worker
that already exists. Run the `rm` whether or not the deploy succeeded; the file
holds secrets.

Deploys are additive for secrets: later deploys do not need the flag unless a
secret changed.

**Without a custom domain, `SITE_ORIGIN` is still empty, and every CMS request
fails until it is set** (only `/api/health`, `/media/*`, `/mcp` and
`/og-render*` answer). So:

1. Take the `https://<name>.<subdomain>.workers.dev` URL from the deploy output.
2. `bun .claude/skills/setup-cloudflare/env.ts var SITE_ORIGIN <that URL>`
3. Build again and deploy again, because the deployed vars come from the build's
   copy of `wrangler.jsonc`, not the source:
   `bun run --cwd apps/web build`, then `bun x wrangler --cwd apps/web deploy`.

With a custom domain, `SITE_ORIGIN` was set in step 3 and one deploy is enough.
The user attaches the domain in the dashboard (Workers & Pages, the Worker,
Settings, Domains & Routes).

Verify:

- After the first deploy: `curl -s <URL>/api/health` returns `{"status":"ok"…}`.
  A new `workers.dev` name can take a minute to resolve; retry a few times.
- After `SITE_ORIGIN` is set: `curl -s -o /dev/null -w '%{http_code}' <URL>/`
  returns 200 (the "Nothing published yet" page) and so does `<URL>/sitemap.xml`.

Done when both checks pass and `bun x wrangler --cwd apps/web secret list` shows
the uploaded names.

## 9. Hand back

Report the account, the Worker name, the five resource names, the URL (or that
the deploy was skipped) and the uncommitted `wrangler.jsonc` diff. Then give the
next step: open `<URL>/admin`, sign in with an `ADMIN_EMAILS` address, go to
`/admin/setup` and click "Import starter content". Leave to the user:

- Committing the `wrangler.jsonc` change. The ids are not secrets, and without
  them a fresh clone deploys against the `local` placeholders.
- Every later migration needs `bun x wrangler --cwd apps/web d1 migrations apply
  DB --remote` before the deploy that depends on it (`bun run deploy` in
  `apps/web` does both).
- A Clerk production instance when the site goes public (the keys from the
  `project-init` Clerk step are for a development instance).
- Renaming the project after this step: `rename-project` changes the names in
  `wrangler.jsonc`, but the resources above keep their old names on Cloudflare.
  A rename after setup means creating new ones.
