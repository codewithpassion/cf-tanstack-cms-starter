import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { robotsTxt } from "#/lib/robots-txt";
import { resolveSiteConfig } from "#/server/cms/wiring";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(robotsTxt(resolveSiteConfig(env, request)), {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
