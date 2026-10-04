import { slugToPath } from "@repo/cms-core/paths";

import { CmsError } from "./pages-service";
import { type RenderSigner, signRenderToken } from "./render-token";

/**
 * Preview links (docs/cms-plan.md §3.6): a page's public path with `?_preview=<token>`, where the
 * token is a "preview" render token bound to the page's id and current slug (render-token.ts;
 * load-page.ts checks both, so the link never shows another page that takes the slug). The
 * editor's Preview button (preview-fns.ts) asks for 24 hours; an agent's `get_preview_url` for an
 * hour, optionally for a staged proposal (`changesetId`) instead of the saved draft. Blog posts
 * preview on their `blog/<slug>` URL like any page.
 */

/** `path`: the public path with the token. `expiresAt`: ISO timestamp. */
export type SignedPreview = { path: string; expiresAt: string };

export async function signPreviewLink(
  signer: RenderSigner,
  page: { id: string; slug: string; status: string },
  opts: { ttlSeconds: number; changesetId?: string; now?: number }
): Promise<SignedPreview> {
  if (page.status === "archived") {
    throw new CmsError("ARCHIVED", "Archived pages can't be previewed.");
  }
  const now = opts.now ?? Date.now();
  const token = await signRenderToken(
    signer,
    {
      slug: page.slug,
      purpose: "preview",
      pageId: page.id,
      ...(opts.changesetId !== undefined && { changesetId: opts.changesetId }),
    },
    { ttlSeconds: opts.ttlSeconds, now }
  );
  return {
    path: `${slugToPath(page.slug)}?_preview=${encodeURIComponent(token)}`,
    expiresAt: new Date(
      Math.floor(now / 1000) * 1000 + opts.ttlSeconds * 1000
    ).toISOString(),
  };
}
