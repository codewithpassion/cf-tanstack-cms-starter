# @repo/cms-core

Isomorphic, pure code shared by the browser, the services and the web app: the page document
types, the ops engine, validation, the block definitions, SEO checks, the agent's pure modules,
site settings, paths, sitemap and llms.txt builders.

## The purity rule

Nothing here imports React, drizzle, `cloudflare:workers`, `@tanstack/*` or reads `env`. Only
`zod` and `nanoid` are dependencies. A function that needs the site's name, origin or a signing
key takes it as a parameter (`SiteConfig` from `site/config`). If code needs one of those
imports, it belongs in `@repo/services` (server), `@repo/db` (rows) or `apps/web` (UI).

`SiteConfig` must always be built with `siteConfig()` from `site/config` (never an object literal
from raw vars): it trims, strips trailing slashes from the origin and throws on an empty or
non-http(s) origin, so no builder has to re-check it.

## Entry points

No barrel file. `exports` is the pattern `"./*": "./src/*.ts"`, so import a module by path:

```ts
import { validatePageDoc } from "@repo/cms-core/validate";
import { BLOCK_DEFS, createBlock } from "@repo/cms-core/blocks/registry";
import type { SiteConfig } from "@repo/cms-core/site/config";
```

Main groups: `types`, `validate`, `new-docs`, `ops/*` (apply, history, summary, sync), `blocks/*`
(one def per block plus `registry`), `richtext/*`, `style/*`, `seo/*` (head builder, checks,
overview, pixel widths), `site/*` (schema, defaults, config), `agent/*` (stage, catalogue,
prompt, tool defs, changesets, runs, limits, cost, models), `editor/*` (diff, style model,
inspector fields), `paths`, `reserved`, `posts`, `sitemap`, `llms`, `gsc/*`, `share/params`.

## Blocks: a def and a Component

Each block is split in two. The def in `src/blocks/<name>.ts` is data: `type`, `version`,
`label`, `icon` (a kebab-case lucide icon name such as `"panel-top"`), `category`, the zod
`schema`, `defaults`, `defaultStyle`, `elements`, `onCard`, `ai` guidance, `migrate`, `jsonLd`.
`blocks/registry.ts` collects them (`BLOCK_DEFS`, `BLOCK_TYPES`, `getBlockDef`, `createBlock`,
`migrateProps`). `validate.ts` and everything that checks documents use only the defs.

The web app pairs each def with what needs React in
`apps/web/src/modules/cms/blocks/registry.ts`: `{ Component, Icon, hiddenWhen }` per `type`,
where `Icon` is the lucide component for the def's `icon` key. To add a block: write the def
here, add its type to `BLOCK_TYPES` and `BLOCK_DEFS`, then add its entry in the web registry.
Adding an icon for feature-grid or logos items means extending `blocks/icon-names.ts` and the
web icon map together.

## Tests

`bun test`. The tests build against `TEST_CONFIG` in `src/test-fixtures.ts`. Tests that need
React, the editor store or files in `apps/web` live in the web app.
