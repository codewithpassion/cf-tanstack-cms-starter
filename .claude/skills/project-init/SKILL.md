---
name: project-init
description: Turn this boilerplate into a named project - asks for the name, renames, sets up Clerk auth, puts the name in the README, and connects Cloudflare for a first deploy.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Skill, Bash(clerk:*), Bash(cp:*), Bash(git:*), Bash(bun:*), Read, Edit, Write
---

# Initialise the project

Runs once, right after cloning the boilerplate.

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
- Set `ADMIN_EMAILS` in `apps/web/.env.local` to the comma-separated emails that
  may use `/admin`.

Never print `.env.local`: it holds secrets.

Done when `.env.local` has the three Clerk keys and `ADMIN_EMAILS`, and
`create-dev-user` (if dev login is on) printed `Created dev user` or
`Updated password`.

## 4. Put the name in the README

`rename-project` already set the `# ` heading of `README.md` to the display name
(`my-app` -> `My App`). Make the intro sentence under it name the project too:

```markdown
# My App

`my-app` is a [Turborepo](https://turborepo.com) monorepo, managed with Bun workspaces.
```

Read the whole `README.md` afterwards. Done when it names the project and no
line still calls it the boilerplate.

## 5. Cloudflare

Invoke the `setup-cloudflare` skill and follow it through. It signs the user
in, records the account, and asks before it creates the D1 database and
deploys. This comes last so the deploy ships the renamed app with Clerk
already connected.

Done when the skill has handed back, whether or not the user chose to deploy.

## 6. Hand back

Report the name, the Clerk app, whether dev login is on, the Worker URL
or that the deploy was skipped, and the uncommitted diff from steps 3 to 5.
Commit only if the user asks. Pass on the follow-ups the invoked skills raised
(an old deployed Worker, the D1 `database_id` in `wrangler.jsonc`, a Clerk
production instance); leave those to the user.
