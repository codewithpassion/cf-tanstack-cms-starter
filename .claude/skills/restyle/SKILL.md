---
name: restyle
description: Change the look of this starter (colours, fonts, radius, logo, card style, block styling). Use when the user says "restyle", "rebrand", "change the colours/font/accent", "make it look like X", or asks for a new theme.
---

# Restyle

The design is a neutral SaaS theme. Human-facing summary: `docs/design.md`. This file is the procedure.

## Where to edit

- `apps/web/src/styles.css`: fonts, theme variables (`:root` light, `.dark`), radius, shadows, and `@theme static` (the CMS brand tokens, as `--color-brand-*`).
- `packages/cms-core/src/editor/style-model.ts`: `TOKEN_CSS`, the same eight hex values as `@theme static`.
- `packages/cms-core/src/style/vars.ts`: `GRADIENTS` presets.
- `apps/web/src/modules/cms/style/cms.css`: `.cms-card` and the `subtle` and `glow` border rules.
- `apps/web/src/modules/cms/blocks/ui.tsx`: buttons, eyebrow, text colour fallbacks. Per-block markup is `blocks/<name>.tsx`; per-block spacing defaults are `packages/cms-core/src/blocks/<name>.ts` (`defaultStyle`).
- `apps/web/src/components/logo.tsx` and `apps/web/public/favicon.svg`: the mark. `og-card.tsx` and `public/og-image.jpg`: share images.

## Invariants

- Change `@theme static` and `TOKEN_CSS` together. Every token is a hex literal in both. `theme-tokens.test.ts` enforces it.
- Token names (`primary`, `primary-soft`, `accent`, `danger`, `ink`, `ink-soft`, `muted`, `white`) and gradient and border names (`glow`, `subtle`) are stored in page documents. Never rename them; change values.
- Brand tokens are `--color-brand-*`, separate from shadcn's `--primary`, `--accent`, `--muted`. Do not alias one to the other.
- Block fallbacks use theme variables (`var(--foreground)`, `var(--muted-foreground)`), never literal white or black, so blocks work in light and dark.
- Never hand-edit `apps/web/src/components/ui/`, `lib/utils.ts` or `hooks/use-mobile.ts` (shadcn output). Restyle through the theme variables.
- Admin and editor chrome use theme classes (`bg-background`, `bg-card`, `border-border`, `text-muted-foreground`). Do not add `neutral-*`, `text-white` or `bg-black` there.
- No native `alert`, `confirm` or `prompt`.

## Steps

1. Edit the files above for the requested change.
2. `cd apps/web && bunx tsc --noEmit && bun test`, then `bunx ultracite check` from the root. Update test expectations that assert class names only when the change is intended.
3. `bun run build`.
4. Verify visually (below). Check light and dark.

## Verify visually

Start the dev server and take screenshots with `agent-browser` (headless, localhost):

```sh
cd apps/web && CF_REMOTE_BINDINGS=0 CI=1 bun run dev      # needs real Clerk keys in .env.local
bun run seed                                              # if no pages exist
agent-browser set viewport 1440 900
agent-browser set media light      # or dark
agent-browser open http://localhost:3000/
agent-browser eval "(async()=>{for(let y=0;y<document.body.scrollHeight;y+=500){scrollTo(0,y);await new Promise(r=>setTimeout(r,120))}scrollTo(0,0)})()"
agent-browser screenshot --full home.png
```

Scroll before a full-page capture: blocks fade in on scroll and stay invisible otherwise. For the admin, open `/api/dev-login` first (dev login), then `/admin/pages` and an `/admin/editor/<id>` page. Repeat at `agent-browser set viewport 390 844`. Check `document.documentElement.scrollWidth` equals the viewport width (no horizontal scroll).
