import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { getMedia, headMedia } from "#/server/routes/media";

/** Public media from R2, cached as immutable; skips Clerk (lib/clerk-skip.ts). Logic: server/routes/media.ts. */
export const Route = createFileRoute("/media/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getMedia(env.CMS_MEDIA, params.id, request),
      HEAD: ({ params }) => headMedia(env.CMS_MEDIA, params.id),
    },
  },
});
