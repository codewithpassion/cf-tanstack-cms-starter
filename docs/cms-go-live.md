# Go-live checklist

Work through this before the site gets real traffic. Run every command from `apps/web`. `/project-init` (or the `setup-cloudflare` skill) already did the first deploy; this list covers what it leaves for you. How the admin works: [cms.md](cms.md).

## 0. Before deploying

- [ ] `bun run check` (repo root) and `bun run test` pass.
- [ ] Record the version that is live now, as the rollback target:
  ```sh
  bunx wrangler deployments list
  ```
- [ ] `VITE_CLERK_PUBLISHABLE_KEY` is in `apps/web/.env.local` (or `.env.production`) on the machine that deploys. Vite bakes it into the build; it is not a Worker secret.
- [ ] `apps/web/wrangler.jsonc` with the real resource ids is committed.

## 1. Variables and secrets

Variables are in `wrangler.jsonc` under `vars`:

| Var | Notes |
| --- | --- |
| `SITE_NAME` | Site name, shown in the chrome; its slug names the MCP server. |
| `SITE_ORIGIN` | The public origin, for example `https://your-site.example`, with no trailing slash. **Required in a deploy**: while it is empty every CMS request fails. |
| `SITE_TIME_ZONE` | IANA zone for "today" (new post dates, the agent's daily budget day). |
| `GSC_PROPERTY` | Search Console property, for example `sc-domain:your-site.example`. Empty disables the sync. |

Secrets:

```sh
bunx wrangler secret list
```

| Secret | Notes |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | From your Clerk application. Use a Clerk production instance for a public site. |
| `ADMIN_EMAILS` | Comma-separated emails that may use `/admin`. Each must be verified on the Clerk account. |
| `PREVIEW_SIGNING_KEY` | 32 random bytes, base64url. Changing it invalidates every preview link and share-image render token. |
| `ANTHROPIC_API_KEY` | Optional. The page agent offers Workers AI models only without it. |
| `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` | Optional, for Search Console (section 4). |

`DEV_LOGIN_EMAIL` and `DEV_LOGIN_PASSWORD` must **not** appear in that list: setting them turns on the dev login, which signs anyone in as the dev admin user.

Set a missing one with `bunx wrangler secret put <NAME>`.

Workers AI and Browser Run are bindings, with nothing to set up. Browser Run draws the share images and the agent's page screenshots.

## 2. Deploy and check

```sh
bun run deploy
```

This builds, applies pending D1 migrations to the remote database (wrangler asks for confirmation in a terminal), then runs `wrangler deploy`. If a migration fails, nothing is deployed.

Check right after:

- [ ] `/api/health` answers `{"status":"ok"…}`.
- [ ] `/sitemap.xml`, `/llms.txt` and `/robots.txt` respond.
- [ ] `/` shows the "Nothing published yet" page, or your home page once published.
- [ ] Sign in at `/login` and open `/admin`. `/admin/setup` shows the page counts and the Search Console state.

### Custom domain

The Worker answers on `https://<name>.<subdomain>.workers.dev`. To use your own domain, attach it in the dashboard (Workers & Pages, the Worker, Settings, Domains & Routes), set `SITE_ORIGIN` to it, then build and deploy again (the deployed vars come from the build's copy of `wrangler.jsonc`). MCP OAuth tokens are bound to the host that issued them, so reconnect Claude.ai and other OAuth apps afterwards. API keys keep working.

## 3. First run in the admin

1. Open `/admin/setup`, click "Import starter content", check the dry run and confirm. This creates drafts only.
2. Replace the lorem ipsum in each page and post, then publish them. Publishing the home page replaces the "Nothing published yet" page.
3. **Site settings** (`/admin/site`): set the navigation, footer, default SEO and default share image, then publish.
4. Replace the placeholder text that is not on a page: the `llms.txt` intro and the agent's positioning text (one file each in the code, marked "edit me"), and the sample posts under `/blog`.
5. **Agent spend caps** (`/admin/setup`, "AI agent settings"): defaults are $3 per conversation and $20 per day. Site-wide runs have a fixed $15 cap per run.

## 4. Connect Search Console (optional)

Details are in the header of `scripts/gsc-auth.ts`.

1. Put `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET` in `apps/web/.env.local`.
2. In the Google Cloud console, the OAuth client must accept `http://localhost:8765` (automatic for a "Desktop app" client; a "Web application" client needs it under Authorized redirect URIs), and the Search Console API must be enabled. Publish the consent screen: while it is in "Testing", the token expires after 7 days.
3. Run `bun run gsc:auth` and sign in as an Owner or Full user of the property. It writes `GSC_REFRESH_TOKEN` to `.env.local` without printing it.
4. Copy it to the Worker: `bunx wrangler secret put GSC_REFRESH_TOKEN`, and set `GSC_PROPERTY` in `wrangler.jsonc`.
5. In `/admin/setup`, backfill the history. After that the daily job (18:00 UTC) keeps it current. `bun run gsc:sync` runs a sync by hand.

## 5. Connect Claude Code or Claude.ai over MCP (optional)

Follow "MCP: API keys and connectors" in [cms.md](cms.md). Checks after the deploy:

- [ ] `curl https://your-site.example/.well-known/oauth-authorization-server` shows `"issuer":"https://your-site.example"` and `"client_id_metadata_document_supported":true`.
- [ ] `curl -i -X POST https://your-site.example/mcp` answers 401 with a `WWW-Authenticate: Bearer` header that points at the protected-resource metadata.
- [ ] A key made in `/admin/api-keys` connects with `claude mcp add`, and `claude mcp list` shows it connected.

## Rollback

**The Worker:**

```sh
bunx wrangler rollback <version-id>
```

Use the version recorded in step 0. D1, KV and R2 are not rolled back; a migration stays applied, so write migrations that the previous version can still run against.

**A published page, with the Worker left in place:** open it in the editor or find it in `/admin/pages` or `/admin/posts` and click Unpublish. It leaves the site at once, the sitemap and `llms.txt` drop it, and the draft and history stay.

If the admin itself is down, delete the page's KV entry instead:

```sh
bunx wrangler kv key delete --binding CMS_PAGES --remote "page:<slug>"
```

The home page's key is `page:` with nothing after it. This leaves D1 marking the page as published, and the sitemap and `llms.txt` list it until the next publish or unpublish rebuilds the index.
