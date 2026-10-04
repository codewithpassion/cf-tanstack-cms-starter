---
name: project-init
description: Turn this starter into a named, deployed CMS site - asks for the name, renames, connects Clerk, sets up Cloudflare (D1, KV, R2, secrets) for a first deploy, then points to /admin to import the starter content.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Skill, Bash(clerk:*), Bash(cp:*), Bash(git:*), Bash(bun:*), Read, Edit, Write
---

# Initialise the project

Runs once, right after cloning the starter. The order is fixed: rename, Clerk
(always), Cloudflare, then the first sign-in at `/admin`.

Start from a clean `git status`. If the tree is dirty, stop and ask the user to
commit or stash first.

## 1. Ask for the name

Use `AskUserQuestion`: "What should this project be called?" Offer the repo
directory's basename as the first option; the user can type another via "Other".

The name must be a valid Cloudflare Worker name: lowercase letters, digits and
hyphens. If the answer is not (`My App`, `my_app`), convert it to kebab-case
(`my-app`) and confirm the converted name with the user before going on.

Done when you hold one confirmed kebab-case name.

## 2. Rename

Invoke the `rename-project` skill with the name and follow it through, including
its commit. Its "still mentions the old name" list includes hits inside
`.claude/skills/`; leave those as they are.

Done when `git status` is clean and the commit names both the old and new name.

## 3. Connect Clerk

The code for Clerk auth is already in the repo, and the admin area needs it, so
there is no question to ask. What is left is a Clerk application and its keys.

- Sign in to the Clerk CLI (`clerk whoami --json`; if needed ask the user to
  run `! clerk auth login`), then pick or create the application with
  `clerk apps list --json` / `clerk apps create "<Display Name>" --json`, and
  `clerk link --app <id>`, all from the repo root.
- `cp -n apps/web/.env.example apps/web/.env.local`, then
  `clerk env pull --app <id> --file apps/web/.env.local`. It fills two of the
  three key names; copy `CLERK_PUBLISHABLE_KEY` to `VITE_CLERK_PUBLISHABLE_KEY`
  (or the reverse) so all three are set.
- Optional dev login: set `DEV_LOGIN_EMAIL` (for example
  `dev@<project-name>.test`) and `DEV_LOGIN_PASSWORD` in `apps/web/.env.local`,
  then `bun run --cwd apps/web create-dev-user`.
- Ask which emails may use `/admin` (comma-separated, verified on the Clerk
  account), then
  `bun .claude/skills/setup-cloudflare/env.ts set ADMIN_EMAILS "<emails>"`.

Never print `.env.local`: it holds secrets.

Done when `.env.local` has the three Clerk keys and `ADMIN_EMAILS`, and
`create-dev-user` (if dev login is on) printed `Created dev user` or
`Updated password`.

## 4. Cloudflare

Invoke the `setup-cloudflare` skill and follow it through. It signs the user
in, records the account, and asks before it creates the D1 database, the two
KV namespaces and the R2 bucket, sets the secrets and `SITE_*` vars, and
deploys. This comes before the admin step so the deploy ships the renamed app
with Clerk already connected.

Done when the skill has handed back, whether or not the user chose to deploy.

## 5. Open the admin

The CMS is empty until it gets content. Tell the user, with their real URL
(`http://localhost:3000` if they skipped the deploy; start it with
`CF_REMOTE_BINDINGS=0 bun run dev`):

1. Open `<url>/admin` and sign in with an address from `ADMIN_EMAILS`. Locally,
   the "Dev login (local only)" link on `/login` does it in one click when
   `DEV_LOGIN_*` is set.
2. Open `/admin/setup` and click "Import starter content". It shows a dry run
   first; confirm it. The import creates drafts only, so publish the pages
   (and the site settings under `/admin/site`) from the editor.

Do not do this for them: it needs their sign-in.

## 6. Hand back

Report the name, the Clerk app, whether dev login is on, the Worker URL or that
the deploy was skipped, and the uncommitted diff from steps 3 and 4. Commit only
if the user asks. Pass on the follow-ups the invoked skills raised (an old
deployed Worker, the resource ids in `wrangler.jsonc`, a Clerk production
instance); leave those to the user. `docs/cms.md` explains the admin and
`docs/cms-go-live.md` lists what to check before the site goes public.
