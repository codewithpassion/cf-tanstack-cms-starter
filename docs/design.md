# Design

The starter looks like a clean neutral SaaS site: white and zinc surfaces, Inter, one indigo accent, 1px borders, soft shadows, 8px radius, and a dark mode that follows the visitor's system setting. This page lists every place to change that.

## Where each knob lives

| Knob | File | What to change |
| --- | --- | --- |
| Fonts | `apps/web/src/styles.css` | The Google Fonts `@import` at the top, then `--font-sans` and `--font-heading` in `@theme inline` |
| Theme colours, light | `apps/web/src/styles.css`, `:root, .light` | `--background`, `--foreground`, `--primary`, `--border`, `--muted-foreground` and the rest. The public site's default text and surfaces, and the whole admin, read these |
| Theme colours, dark | `apps/web/src/styles.css`, `.dark` | The same variables |
| Radius and shadows | `apps/web/src/styles.css`, `:root` | `--radius` (0.5rem is 8px), `--elevation-soft`, `--elevation-lift` (exposed as the `shadow-soft` and `shadow-lift` utilities) |
| CMS brand tokens | `apps/web/src/styles.css`, `@theme static` and `packages/cms-core/src/editor/style-model.ts`, `TOKEN_CSS` | The eight colours the editor offers: `primary`, `primary-soft`, `accent`, `danger`, `ink`, `ink-soft`, `muted`, `white`. Change each hex in both files |
| Gradient presets | `packages/cms-core/src/style/vars.ts`, `GRADIENTS` | The CSS behind each preset name |
| Card surface and border styles | `apps/web/src/modules/cms/style/cms.css`, `.cms-card` | The default card, plus the `subtle` and `glow` border rules |
| Block defaults (spacing, alignment, background) | `packages/cms-core/src/blocks/<name>.ts`, `defaultStyle` | Per block type |
| Block markup and classes | `apps/web/src/modules/cms/blocks/*.tsx`, shared pieces in `ui.tsx` | Buttons, eyebrow, text colour fallbacks |
| Swatches the editor offers | `packages/cms-core/src/starter-content.ts` (starter content) and Site settings in the admin | The colour picker list per site |
| Logo and wordmark | `apps/web/src/components/logo.tsx` | The glyph paths. The name comes from the `SITE_NAME` var |
| Favicon | `apps/web/public/favicon.svg` | Same glyph as the logo, with literal hex colours |
| Default share image | `apps/web/public/og-image.jpg` | A 1200 by 630 file used until a page sets its own |
| Generated share card | `apps/web/src/modules/cms/share/og-card.tsx` | Layout of the card the editor renders for pages and posts |
| Nav, footer, empty home, 404 | `apps/web/src/components/{navigation,footer,not-found-page}.tsx`, `apps/web/src/routes/index.tsx` | Markup and classes |
| Admin | nothing separate | The admin uses the theme variables above, so it follows them and light/dark |

Do not edit `apps/web/src/components/ui/`. It is shadcn output; restyle through the theme variables instead.

## Brand tokens and the theme variables are two systems

The shadcn variables (`--primary`, `--accent`, `--muted`) drive the admin and any shadcn component. The CMS brand tokens are separate: they are stored by name in page documents and written as `var(--color-brand-<token>)`. Setting the brand `accent` to sky does not turn shadcn hover highlights sky. Token names are stored in content, so never rename them; only change values.

An unstyled block uses the theme variables, not the tokens, so it follows dark mode. A token only appears where an editor picked it. Tokens are the same in light and dark, so pick ones that read on both, or leave them for accents.

## Rebrand in five minutes

1. Pick your accent. In `styles.css` set `--primary` in `:root` and `.dark` (a darker step for light, a brighter one for dark), and `--ring` to match.
2. Set the brand tokens: `--color-brand-primary` and `--color-brand-primary-soft` in `@theme static`, then the same hex values in `TOKEN_CSS`. Do the same for `accent` if you want a second hue.
3. Change the font: swap the Google Fonts URL and the two `--font-*` lines.
4. Swap the logo glyph in `components/logo.tsx` and `public/favicon.svg`. Set `SITE_NAME` in `wrangler.jsonc`.
5. Adjust `--radius` if you want sharper or rounder corners.
6. Run `bun run test` (the theme-tokens test fails if the two token lists drift), then look at the pages below in light and dark.

## How to check

```sh
cd apps/web
CF_REMOTE_BINDINGS=0 bun run dev   # http://localhost:3000
bun run seed                        # starter pages and posts, if the database is empty
```

Look at `/`, `/about`, `/pricing`, `/blog`, a post, `/admin/pages` and an editor page, in light and dark (the theme button in the nav), at desktop width and about 390px. `bun run test` runs the token test (`modules/cms/style/theme-tokens.test.ts`) and the contrast tests that rate colours against `TOKEN_CSS`.
