# How the CMS works

For the people who use it. Everything lives under `/admin`, which only the emails in `ADMIN_EMAILS` can open. Examples use `https://your-site.example` for the site's address.

## Pages

`/admin/pages` lists every page. A page has a slug (its address), a title and a document made of blocks. The home page has the empty slug. The CMS serves every address that code does not own, so a page at `pricing` answers at `https://your-site.example/pricing`.

Some slugs belong to code and cannot be used for pages: `admin`, `api`, `blog`, `mcp`, `media`, `oauth`, `og-render` and `og-render-agent` (each with everything under it), plus `login`, `dev-login`, `sitemap.xml`, `llms.txt`, `llms-full.txt` and `robots.txt`. The new-page form checks the slug as you type.

Pages are archived, not deleted, because revisions and agent history point at them. An archived page leaves the site and frees its slug.

## Blocks

A block is one section of a page. The starter has 14, in four groups:

| Group | Blocks |
| --- | --- |
| Layout | hero |
| Content | feature grid, steps, stats, FAQ, checklist, callout, logos, testimonial, rich text |
| Media | image |
| Conversion | pricing, call to action |

The post list block is a content block too: it shows the newest posts, optionally from one category. Each block has its own fields, a style (colors, spacing, border, background) and, where it makes sense, per-element text styles. Old documents are migrated forward when a block's version changes.

## The editor

Open a page from the list. The page renders on a live canvas inside an iframe, so what you see is what visitors get.

- The "Add block" button in the Layers header adds blocks. The layers panel shows the page as a tree and reorders it by drag and drop.
- Click a block on the canvas to edit it in the inspector. Text fields use a rich text editor (bold, italic, links, lists).
- The Style sub-tab of the Inspector (next to Content) sets colors from the site's swatches, gradients, spacing and borders.
- Edits save to the draft as small operations. Each save carries the draft's version, so if the same page was changed somewhere else (another tab, the agent, an MCP client) you get a stale-draft message instead of an overwrite.
- The history panel lists revisions, lets you name and pin one, compare it with the draft, and restore a whole revision or a single block from it.

## Publish and preview

A draft is private. Publish (it asks you to confirm) makes the current draft the live revision and writes a snapshot of it to KV. Public requests read that snapshot and never touch the database. Unpublish takes the page down at once; the draft and history stay. Rollback makes an earlier revision live again.

Preview gives you a signed link, valid for one hour, that shows the draft at the page's public address. Previews are never cached or indexed. A page whose KV write failed shows "published, not live yet" with a retry.

## SEO

The SEO panel in the editor sets the title, description, slug, canonical address, robots (index and follow), sitemap inclusion, focus keyphrase, the social title, description and image, and the schema.org page type. It shows how the title and description will fit in search results (measured in pixels). A checklist flags common problems: title and description length, titles repeated on other pages, slug rules, the share image. Blocks add structured data (JSON-LD) to the page; for example an FAQ block adds FAQ markup.

`/admin/seo` shows every page with its issues, joined with Search Console numbers when that is connected. `sitemap.xml`, `llms.txt` and `llms-full.txt` are built from the published pages and posts and are rebuilt on each publish. `llms.txt` has an intro paragraph that you should replace with your own.

## Share images

The share image is the picture shown when a link is posted on social media. The "Create share image…" button on SEO > Fields opens a builder that offers three templates (hero, card, post), lets you override the text, and renders the image with Cloudflare Browser Run. The result is saved to the media library and set on the page. Without a custom image, pages use the default share image from the site settings.

## Site settings

`/admin/site` holds what appears on every page: the navigation (with dropdown children), the footer (columns, highlights, legal links), the color swatches the Style sub-tab offers, default SEO and the default share image. It has its own draft, publish and history, separate from pages.

## Blog

Posts are pages of kind "post" at `blog/<slug>`. `/admin/posts` lists them and creates new ones with a title, slug, category and author; the date comes from `SITE_TIME_ZONE`. A post is edited like a page, with a post panel for the byline, date and category. `/blog` lists published posts, and the post list block shows the newest posts anywhere on the site.

## Media

`/admin/media` is the library, backed by R2. Uploads are checked by content (not just the file name), stripped of EXIF data and de-duplicated. Each image has alt text, which the agent can suggest, and a "used on" list. Files are served from `/media/<id>` with long-lived cache headers. Media is never deleted, because published pages and agent history may refer to it.

## The AI agent

Each page has an AI tab: a conversation with an agent that can read the page, the site and the media library, and propose changes. A proposal is never applied silently. You review it as a diff, accept all of it or part of it, or reject it. If the page changed since the proposal, you see the conflict first.

`/admin/agent` runs the agent over many pages at once ("site-wide runs"), for example fixing every missing meta description, with a review queue of the results.

Models: Claude, when the `ANTHROPIC_API_KEY` secret is set, and Workers AI models, which need no key. Spending is capped: the defaults are $3 per conversation, $20 per day and $15 per site-wide run. Change the first two under `/admin/setup` ("AI agent settings"). The day boundary follows `SITE_TIME_ZONE`. The agent's built-in positioning text and the `llms.txt` intro are placeholders; replace them with your own.

## Search Console

With a Google OAuth client and a refresh token (see [cms-go-live.md](cms-go-live.md)) and `GSC_PROPERTY` set, a daily job at 18:00 UTC pulls clicks, impressions and positions per page and URL-inspection results. They show in the editor's SEO panel, on `/admin/seo` and as "striking distance" opportunities. `/admin/setup` backfills history.

## MCP: API keys and connectors

The CMS runs an MCP server at `https://your-site.example/mcp`, so Claude Code, Claude Desktop and Claude.ai can do what the admin can. Keys and connections live under `/admin/api-keys`. Three scopes apply to both:

- `read`: read pages, SEO data, revisions, the review queue.
- `write`: also edit drafts, create pages and posts, propose changes, upload media, accept or reject proposals, save versions and restore.
- `full`: also publish, unpublish, archive, unarchive, roll back and publish the site settings.

### API key (Claude Code)

1. Open `/admin/api-keys`, name a key, pick a scope and create it. The key is shown once. Production keys start `cms_live_`; keys made in local dev start `cms_dev_` and only work against the local database.
2. Run the command the page shows, with the key filled in:

   ```bash
   claude mcp add --transport http <site-slug> https://your-site.example/mcp --header "Authorization: Bearer <key>"
   ```

   `<site-slug>` is `SITE_NAME` as a slug, for example `my-site`.
3. `claude mcp list` should show it connected.

Only a key's SHA-256 is stored. Revoking a key stops it on the next request (HTTP 401).

### OAuth connector (Claude.ai, Claude Desktop, Claude Code)

1. In Claude.ai open Settings, Connectors, Add custom connector, and enter `https://your-site.example/mcp`.
2. When asked how to authenticate, choose "Use Claude's published identity". Creating a client also works.
3. Sign in if asked. Only an admin can approve. Pick a scope (default `write`) and approve.

Claude Code can use the same flow without a key: `claude mcp add --transport http <site-slug> https://your-site.example/mcp`, then `claude mcp login <site-slug>`.

Connections are listed under "Connected apps" on `/admin/api-keys`, with their calls, and Revoke stops one. A connection lasts 30 days from approval, then the app asks you to sign in again. Tokens are bound to the host that issued them, so after moving to a custom domain, reconnect the apps. Locally, OAuth works on `localhost` and `127.0.0.1` only; on any other plain-http host use API keys.

Every change made over MCP is recorded in the page history as `mcp:<key or app name>`, and the key's page shows its last 50 calls. Call logs are deleted after 90 days.
