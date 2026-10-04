# @repo/db

The database layer of the monorepo: a [Drizzle](https://orm.drizzle.team) schema for [Cloudflare D1](https://developers.cloudflare.com/d1/) with every table of the CMS, the generated migration, and the table modules that query them.

## Entry points

One entry per module in `package.json` `exports`, no barrel file. Only `@repo/services` imports the table modules; the app reaches them through the services. Anything a React component needs comes from `@repo/db/shared`, because every other entry pulls drizzle into the browser bundle.

| Import | Contents | Where it may run |
| --- | --- | --- |
| `@repo/db/shared` | Browser-safe constants and unions (`PAGE_STATUSES`, `API_SCOPES`, `SITE_ID`, `D1_MAX_PARAMS`, ...) and the `PageDoc`/`SiteDoc` aliases. No drizzle. | Anywhere, including React components |
| `@repo/db` | The 19 tables, the inferred row types (`PageRow`, `RevisionRow`, `MediaRow`, `ApiKeyRow`, ...), the `Database` and `D1Db` types | Server only |
| `@repo/db/pages` | Pages, posts and their append-only revisions: `createD1Repo` (the page service's repo), `createPageQueries` (posts list, SEO summaries, slug owners), `ChangesetDecided` | Server, D1 only |
| `@repo/db/site` | The single `site` row and `site_revisions`: `createSiteD1Repo` | Server, D1 only |
| `@repo/db/media` | The media table: `createD1MediaRepo`, `mediaSizes`, `mediaUsage` ("used on") | Server, D1 only |
| `@repo/db/gsc` | Search Console reads (`pagePerformance`, `seoGscOverview`, `strikingRows`) and the sync's storage (`replaceWindow`, `publishedPages`, `lastInspections`, `insertInspection`) | Server, D1 only |
| `@repo/db/agent-store` | The AI agent's threads, turn lock, transcript, changesets, runs, spend and budget: `createD1AgentStore` | Server, D1 only |
| `@repo/db/api-keys` | MCP API keys (`createApiKeyTable`) and the call log (`createMcpCallLog`) | Server |
| `@repo/db/oauth-connections` | OAuth grants to the MCP server: `createOauthConnectionTable` | Server |
| `@repo/db/test-utils` | `createTestDb()`: the migrated `bun:sqlite` stand-in for D1 | Tests only (imports `bun:sqlite`) |

Row types come from `@repo/db` (inferred from the schema), per the architecture note: services may `import type` them, `@repo/cms-core` must not import this package.

## Tables

| Area | Tables |
| --- | --- |
| Pages | `pages`, `revisions` (append-only), `revision_labels` (rename and pin kept apart so `revisions` stays append-only) |
| Site settings | `site` (one row), `site_revisions` |
| Media | `media` |
| Search Console | `gsc_rows`, `gsc_page_days`, `gsc_inspections` |
| AI agent | `agent_threads`, `agent_messages` (append-only transcript), `agent_changesets`, `agent_runs`, `agent_usage`, `agent_settings`, `agent_budget_overrides` |
| MCP | `api_keys`, `oauth_connections`, `mcp_calls` |

Ids are text, timestamps are integer milliseconds (`mode: "timestamp_ms"`, so rows carry `Date`s), JSON columns are text in json mode. `pages.draft_base_rev_id` and `live_rev_id` point at `revisions.id` without a foreign key, because `revisions.page_id` already references `pages.id` and the reverse key would make the tables circular.

## D1-only modules

`pages`, `site`, `media`, `gsc` and `agent-store` take a `D1Db` (`DrizzleD1Database<typeof schema>`) rather than the generic `Database`. D1 has no interactive transactions, so a multi-row write that must be atomic is one `db.batch([...])`, and `batch` exists only on the D1 driver. They also read `.run().meta.changes`, which is D1's result shape.

The compare-and-set writes depend on that:

- `createD1Repo(db).commit` (pages) and `createSiteD1Repo(db).commit` put a guard `SELECT json(CASE WHEN count(*) = 1 THEN '0' ELSE '...' END)` first in the batch. When no row has the expected `draft_version`, `json()` raises on the malformed input and the whole batch rolls back, so neither the update nor the revision inserts happen. The catch block then tells a stale version (returns `false`) from any other failure (rethrown). A raw `db.run(sql)` can't bind its parameters inside a D1 batch, which is why the guard is a select builder.
- `commit` can also decide an agent proposal in the same batch, and throws `ChangesetDecided` (nothing written) when it was decided already.
- `agent-store` appends a turn's rows in one batch, takes the turn lock with a conditional `UPDATE`, and saves runs with a compare-and-set on `agent_runs.version`.
- `gsc.replaceWindow` deletes a date window and re-inserts it in one batch, in chunks that stay under D1's 100 bound parameters.

`api-keys` and `oauth-connections` only use single statements, so they take the same `D1Db` for consistency but would work on any drizzle SQLite instance.

## What the table modules do and don't do

- Query functions take a drizzle instance, they never make one. The app passes `drizzle(env.DB, { schema })` from `drizzle-orm/d1`; this package never reads `env` or a binding.
- No validation here. The service in `@repo/services` validates input first.
- Row-level only for keys and connections: key generation, hashing, name rules, the `<client> (<date>)` label and the token checks are services' job. These modules hand back raw rows (with `Date`s), and tRPC carries them through superjson.
- Where a query needs the site's public URL (Search Console rows are keyed by full URL) the caller passes `pageUrl: (slug) => string`, so the origin comes from the site config, not from this package.
- The port interfaces (`CmsRepo`, `SiteRepo`, `MediaRepo`, `AgentStore`) belong to `@repo/services`. Each factory here is typed with a structurally equal local type (`PageRepo`, `SiteRepo`, `MediaTable`, `AgentStoreTable`) so it satisfies the port without importing services.

## Schema and migrations

`src/schema.ts` defines the tables. After changing it, generate a migration:

```bash
bun run generate            # drizzle-kit generate, writes migrations/
```

`migrations/0000_cms.sql` is the single migration for the whole schema. Add changes as new migrations; don't edit one that has been applied anywhere.

Migrations are applied by wrangler, not by drizzle-kit. `apps/web/wrangler.jsonc` points its `migrations_dir` at `migrations/` here, and the D1 binding is `DB`, so from `apps/web`:

```bash
wrangler d1 migrations apply DB --local     # the local miniflare database
wrangler d1 migrations apply DB --remote    # the real D1 database
```

`bun run dev` in `apps/web` (and at the repo root) runs the `--local` one before starting the dev server, so a fresh clone has an up-to-date local database.

Commit `migrations/`, including `migrations/meta/`. Drizzle diffs the schema against the snapshot in there, so without it the next `generate` would try to create the tables again.

## Tests

```bash
bun test
```

`createTestDb()` in `src/test-utils.ts` opens an in-memory `bun:sqlite` database, applies every file in `migrations/`, and returns a `D1Db` over it. `drizzle-orm/bun-sqlite` has no `batch`, so the stand-in speaks D1 instead (prepare, bind, `all`/`run`/`raw`, and a `batch` that runs in one transaction and rolls back on the first failure). The real SQL and the real migrations run, and the compare-and-set guards are testable. No server, no network, no Miniflare.

```ts
import { createTestDb } from "@repo/db/test-utils";
import { createD1Repo } from "@repo/db/pages";

const { db } = createTestDb();
const repo = createD1Repo(db);
```

SQLite foreign keys are off in `bun:sqlite` by default, unlike D1, which always enforces them; a test that depends on a foreign key failing needs `sqlite.run("PRAGMA foreign_keys = ON")` on the `sqlite` handle it also returns.
