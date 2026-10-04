import { env } from "cloudflare:workers";
import { readPagesIndex } from "@repo/services/cms/pages-index";
import { createFileRoute } from "@tanstack/react-router";
import { resolveSiteConfig } from "#/server/cms/wiring";
import { llmsTxtResponse } from "#/server/routes/llms";

/** /llms.txt: the intro plus opted-in CMS pages from KV `pages:index`. Logic: server/routes/llms.ts. */
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        llmsTxtResponse(
          "llms",
          resolveSiteConfig(env, request),
          await readPagesIndex(env.CMS_PAGES)
        ),
    },
  },
});
