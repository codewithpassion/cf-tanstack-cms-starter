import { env } from "cloudflare:workers";
import { readPagesIndex } from "@repo/services/cms/pages-index";
import { createFileRoute } from "@tanstack/react-router";
import { resolveSiteConfig } from "#/server/cms/wiring";
import { sitemapResponse } from "#/server/routes/sitemap";

/** /sitemap.xml from KV `pages:index`. Logic: server/routes/sitemap.ts. */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        sitemapResponse(
          resolveSiteConfig(env, request),
          await readPagesIndex(env.CMS_PAGES)
        ),
    },
  },
});
