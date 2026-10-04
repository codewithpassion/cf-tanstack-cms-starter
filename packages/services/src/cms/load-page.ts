import { getPage, type ServiceDeps } from "./pages-service";
import {
  type CmsPageResult,
  readCmsPage,
  readPreviewPage,
  withPosts,
} from "./read-page";
import { type RenderSigner, verifyRenderToken } from "./render-token";

export type { CmsPageResult } from "./read-page";

/**
 * What the public page loader needs. `pages` backs the draft read of a preview (D1 for that one
 * page); `changeset` reads a staged agent proposal (its page, status and proposed document): the
 * web app backs it with the agent store, which the services' agent modules own.
 */
export type LoadPageDeps = {
  kv: { get: (key: string) => Promise<string | null> };
  signer: RenderSigner;
  pages: ServiceDeps;
  changeset: (
    id: string
  ) => Promise<{ pageId: string; status: string; doc: unknown } | null>;
};

/**
 * `readCmsPage` plus draft previews, for the web app's public page loader; routes decide what a
 * redirect or a miss means for them.
 *
 * `preview` is the request's `?_preview=` token. When it is a valid "preview" token for this path's
 * slug and for the page that holds the slug now (its `pageId` claim), the page's DRAFT comes back
 * instead, read from D1 for that one page (docs/cms-plan.md §3.6), or the staged agent proposal the
 * token names; any other token is ignored.
 */
export async function loadCmsPage(
  deps: LoadPageDeps,
  input: { path: string; preview?: string }
): Promise<CmsPageResult> {
  if (input.preview) {
    const preview = await readPreviewPage(
      {
        kv: deps.kv,
        // A missing signing key throws: logged once by readPreviewPage, and the live page is shown.
        verify: async (slug, token) => {
          const res = await verifyRenderToken(deps.signer, token, {
            slug,
            purpose: "preview",
          });
          return res.ok ? res.claims : null;
        },
        draft: async (slug) => {
          const page = await getPage(deps.pages, { slug });
          return page ? { id: page.id, doc: page.draftDoc } : null;
        },
        changeset: deps.changeset,
      },
      input.path,
      input.preview
    );
    if (preview) {
      return withPosts(deps.kv, preview);
    }
  }
  return withPosts(deps.kv, await readCmsPage(deps.kv, input.path));
}
