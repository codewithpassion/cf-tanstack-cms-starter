---
name: rename-project
description: Rename this monorepo and everything that carries its name - workspace name, bun.lock, the Cloudflare Worker, D1 database and R2 bucket names in wrangler.jsonc, the SITE_NAME var, .cta.json and README headings. Use when the user says "rename this project to X", "call this project X", or is turning the starter into a real named app.
allowed-tools: Bash(bun .claude/skills/rename-project/rename.ts:*), Bash(git:*), Read, Edit
---

# Rename the project

Run the script with the new name. It derives the current name from the root
`package.json`, so nothing else needs to be passed in.

```bash
bun .claude/skills/rename-project/rename.ts <new-name>
```

The name must be a valid Cloudflare Worker name: lowercase letters, digits and
hyphens. The script also derives a display name from it (`my-app` -> `My App`)
for the README headings and `SITE_NAME`.

## What it touches

| Target | Field |
| --- | --- |
| `package.json` | `name` |
| `bun.lock` | root workspace `name` (first match only, so a like-named dependency is safe) |
| `apps/*/wrangler.jsonc` | `name` (the deployed Worker), `database_name` (`<name>-cms`), `bucket_name` (`<name>-cms-media`) and `vars.SITE_NAME` (the display name) |
| `apps/*/.cta.json` | `projectName` |
| `README.md`, `apps/*/README.md` | first `# ` heading |

`SITE_NAME` is the one place the site's name lives. The site header and footer,
the browser tab title fallback and the MCP server name (its slug, for example
`my-app`) all read it, so there is nothing else to rewrite. The script only
replaces a `SITE_NAME` that still holds the old display name; a value the user
has customised shows up as `unchanged`, which is correct.

`apps/web/package.json` stays `"name": "web"` on purpose. That is the workspace
path identity `turbo --filter=web` resolves, not the project name. Likewise
`packages/db` stays `@repo/db`: the `@repo` scope is deliberately not the
project name.

## Cloudflare resources

Renaming a file field does not rename anything on Cloudflare. The two KV
namespaces (`<name>-cms-pages`, `<name>-cms-oauth`) are not named in any file:
`setup-cloudflare` creates them from the Worker name. Before `setup-cloudflare`
has run this costs nothing: it creates everything under the new name. After it
has run:

- Locally, the next `bun run dev` applies the migrations to an empty database
  under the new name.
- On Cloudflare, the old D1 database, KV namespaces, R2 bucket and Worker stay
  where they are, with their data. The next `bun run deploy` creates a **new**
  Worker. To move over, re-run `setup-cloudflare` (it creates the new resources
  and writes their ids), and tell the user to delete the old Worker and re-point
  any custom domain. Do not delete anything for them.
- `SITE_ORIGIN` follows the Worker name on `workers.dev`, so it changes too;
  `setup-cloudflare` sets it again.

## After it runs

Read the output. Two parts need your judgement.

- **`unchanged` lines.** A target that did not move. Either the regex missed it
  or it already said the right thing. Usually fine, but open it if unsure.
- **The "still mentions the old name" list.** The script deliberately leaves
  prose alone, because the old name can be an ordinary word that shows up in
  sentences, where rewriting it produces nonsense. Decide per line, and edit the ones that are
  genuinely the project name. Hits inside `.claude/skills/` and `docs/` are
  documentation of the starter; leave them.

The script finishes with `bun install --frozen-lockfile` to prove the lockfile
still matches `package.json`. If that fails, the lockfile name did not get
rewritten.

Then commit, naming both the old and new name in the subject.
