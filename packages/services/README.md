# @repo/services

The service layer: business rules and input validation, on top of the table modules in [`@repo/db`](../db) and the pure logic in [`@repo/cms-core`](../cms-core). The web app calls it through tRPC (`apps/web/src/server/trpc/`), but nothing here knows about tRPC, Hono or Cloudflare. A script or a test can use a service the same way.

## Entry points

`exports` is the pattern `"./*": "./src/*.ts"`: one entry per module, no barrel file. Import a module by path:

```ts
import { createPagesService } from "@repo/services/cms/pages-service";
import { createApiKeysService } from "@repo/services/mcp/keys";
```

Everything here is server-only (services import `@repo/db`). Three modules are also what the browser needs and import only `@repo/db/shared` or types: `mcp/scopes`, `mcp/author` and `cms/admin-result`.

| Module | Contents |
| --- | --- |
| `cms/pages-service` | Page lifecycle: drafts, ops, revisions, restore, publish to KV, unpublish, archive; `createPagesService(deps)` |
| `cms/history-admin` | The history panel's bodies, returning `adminResult` unions; `createHistoryAdmin(deps)` |
| `cms/site-service`, `cms/read-site` | Site doc lifecycle (draft, versions, publish to KV `site`); `readSite`, `readSiteSeo` for the public read; `createSiteService(deps)` |
| `cms/posts-admin` | The `/admin/posts` list, new post, slug check, published posts; `createPostsAdmin(deps)` |
| `cms/read-page`, `cms/load-page`, `cms/pages-index` | The public read path (KV only), draft previews, the `pages:index`/`posts:index` readers; `loadCmsPage(deps, input)` |
| `cms/render-token`, `cms/preview-link` | HMAC render tokens and preview links; both take `{ signingKey }` |
| `cms/media-service`, `cms/media-bytes` | Upload (type sniffing, EXIF strip, dedupe), list, alt text; `createMediaService(deps)` |
| `cms/admin-result`, `cms/admin-errors` | The `adminResult` union (`{ ok: true, ... } \| { ok: false, code, message }`) and the `CmsError`/`OpError` mapping |
| `mcp/keys` | API keys (`cms_live_` / `cms_dev_`, SHA-256 only), the call log and its 90-day retention; `createApiKeysService(deps)` |
| `mcp/connections` | OAuth connections: client label, `<client> (<date>)` name, token check, revoke; `createConnectionsService(deps)` |
| `mcp/scopes`, `mcp/author` | Scope helpers, OAuth scopes, `claudeMcpAddCommand`, `mcpServerName`; the `mcp:<name>#<prefix>` revision author |
| Port types: `cms/kv`, `cms/repo`, `cms/site-repo`, `cms/media-repo`, `mcp/ports` | The port types (below) |
| `clock` | `Clock`, `systemClock` |
| `testing/*` | In-memory fakes for tests: `memory-repo` (`CmsRepo`), `site-memory-repo`, `media-memory-repo`, `memory-kv`, `media-fixtures` |

The AI agent (`agent/`: the turn loop, run orchestration, tool executors, budget, model providers, and the `AgentStore` port in `agent/store-port.ts`) and the Search Console sync (`gsc/`: client, sync, cron, admin calls) are in the same package.

## The port pattern

A service is a module of functions over a `deps` object, plus a `create*Service(deps)` factory that binds the ports (`cms/bind.ts`). The deps hold ports, never an `env`:

| Port | File | Backed in the app by |
| --- | --- | --- |
| `CmsRepo` | `cms/repo` | `createD1Repo(db)` from `@repo/db/pages` |
| `SiteRepo` | `cms/site-repo` | `createSiteD1Repo(db)` from `@repo/db/site` |
| `MediaRepo` | `cms/media-repo` | `createD1MediaRepo(db)` from `@repo/db/media` |
| `PostQueries` | `cms/posts-admin` | `createPageQueries(db)` from `@repo/db/pages` |
| `ApiKeyStore`, `McpCallLog` | `mcp/ports` | `createApiKeyTable(db)`, `createMcpCallLog(db)` from `@repo/db/api-keys` |
| `OauthConnectionStore` | `mcp/ports` | `createOauthConnectionTable(db)` from `@repo/db/oauth-connections` |
| `KvPort` (`get`/`put`/`delete`) | `cms/kv` | a `KVNamespace` (`env.CMS_PAGES`) as is |
| `BlobPort` (`put`) | `cms/media-repo` | an `R2Bucket` (`env.CMS_MEDIA`) as is |
| `OAuthGrants` (`listUserGrants`, `revokeGrant`) | `mcp/ports` | an adapter over `server.getOAuthApi(env)` of the OAuth provider library |
| `validate`, `labelFor` | `cms/pages-service` (`ServiceDeps`) | `validatePageDoc` and `(t) => getBlockDef(t)?.label ?? t` from `@repo/cms-core` |
| `Clock` | `clock` | `systemClock` |

`src/ports.typecheck.ts` assigns each `@repo/db` factory to its port (`const _: CmsRepo = createD1Repo(db)`), so `tsc` fails when a table module and a port drift apart.

Site name, origin and Search Console property are a `SiteConfig` (`@repo/cms-core/site/config`) passed in `SiteDeps.config`; the render-token signing key is `{ signingKey }`. The web app reads `SITE_NAME`, `SITE_ORIGIN` and `PREVIEW_SIGNING_KEY` and passes them.

## How the web app wires it

`apps/web/src/server/cms/wiring.ts` builds the adapters from `env` once per request (`cmsServices(env, ...)`), and the tRPC context puts the result on `ctx.services.cms`. In outline:

```ts
const db = drizzle(env.DB, { schema });
const pagesDeps = {
  repo: createD1Repo(db),
  kv: env.CMS_PAGES,
  validate: validatePageDoc,
  labelFor: (t) => getBlockDef(t)?.label ?? t,
  author: user.id,
};
const pages = createPagesService(pagesDeps);
const media = createMediaService({ repo: createD1MediaRepo(db), blobs: env.CMS_MEDIA });
const keys = createApiKeysService({ keys: createApiKeyTable(db), calls: createMcpCallLog(db) });
```

Pass the raw `env.SITE_ORIGIN ?? ""` to `keyEnvFor(requestOrigin, siteOrigin)`, not `config.origin` (which falls back to the request origin): an empty site origin makes every key `cms_dev_`.

`author` is the admin's user id, recorded on the revisions a call writes. Admin gating is the tRPC `adminProcedure`; services take no redirect or `href`, and a failure the editor shows comes back as an `adminResult` union.

## Writing a service

- Take ports. Never read `env`, bindings or the request; the caller passes in what the service needs, including the user id when a rule depends on it.
- Use `@repo/cms-core/*` for pure logic and `import type` row types from `@repo/db` (D4).
- Methods are `async`, so a validation error rejects the promise rather than throwing synchronously.
- Expected failures (`CmsError`, `OpError`) go through `adminResult`; only auth failures are `TRPCError`, in the router (D8).
- Add the factory to `bind.ts`-style `create*Service` and a line in `apps/web/src/server/cms/wiring.ts`.

## Tests

```bash
bun test
```

Services are tested against in-memory fakes of their ports (`src/testing/`) and, for keys, connections and the end-to-end cases in `cms/services.test.ts`, against the real `@repo/db` table modules on `createTestDb()`. Validation is the real `validatePageDoc` from `@repo/cms-core`. D1 queries (media usage, page queries) are tested in `@repo/db`.
