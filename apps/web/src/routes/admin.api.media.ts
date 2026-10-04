import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { assertAdminApi } from "#/server/cms/admin";
import { cmsServices } from "#/server/cms/wiring";
import { handleMediaUpload } from "#/server/routes/media-upload";

/** Multipart media upload; admin only (asserted before the body is read). Logic: server/routes/media-upload.ts. */
export const Route = createFileRoute("/admin/api/media")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleMediaUpload(request, {
          assertAdmin: assertAdminApi,
          upload: (userId, input) =>
            cmsServices(env, { author: userId, request }).media.uploadMedia(
              input
            ),
        }),
    },
  },
});
