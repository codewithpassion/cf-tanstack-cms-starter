# @repo/services

The service layer: business rules and input validation, on top of the query functions in [`@repo/db`](../db). The web app calls it through tRPC (`apps/web/src/server/trpc/`), but nothing here knows about tRPC, Hono or Cloudflare. A script or a test can use a service the same way.

## Entry points

| Import | Contents |
| --- | --- |
| `@repo/services/clock` | `Clock`, `systemClock`: the clock port |

One entry per module, no barrel file, same as `@repo/db`. Everything here is server-only: services import drizzle-backed modules. TODO(cms-port): the CMS services (pages, site, posts, media, api keys, agent runs, Search Console sync) arrive in phase 2.

## Using it

A service is a factory that takes its ports: repositories built on a drizzle instance, a KV-like port, an R2-like port, a clock. Nothing here reads `env`, so the same service runs on the Worker and in a test:

```ts
import { systemClock } from "@repo/services/clock";

// const pages = createPagesService({ repo, kv, clock: systemClock });
```

In the app, `apps/web/src/server/trpc/context.ts` builds the services once per call and puts them on `ctx.services`.

## Writing a service

- Export the input schema (zod). The tRPC router passes it to `.input()`, and the service parses with it again, so a caller that skips tRPC still gets validated input.
- Methods are `async`, so a validation error rejects the promise rather than throwing synchronously.
- Take ports. Never read `env`, bindings or the request; the caller passes in what the service needs, including the user id when a rule depends on it.
- Return plain shapes from `@repo/db/shared`.

A new service also needs a line in `apps/web/src/server/trpc/context.ts`.

## Tests

```bash
bun test
```

Services are tested against in-memory fakes of their ports. D1 table modules are tested in `@repo/db`.
