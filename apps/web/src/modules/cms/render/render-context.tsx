import type { PostSummary } from "@repo/cms-core/posts";
import { createContext, useContext } from "react";

/**
 * Site data blocks need at render time that isn't part of the page document, loaded by the CMS
 * route loaders and provided by `CmsPage` (docs/cms-plan.md §3.3): the published posts (KV
 * `posts:index`, newest first) for the `postList` block, loaded only for pages that have one. The
 * editor canvas provides them too.
 */
export type CmsRenderData = {
  posts?: PostSummary[];
};

export const CmsRenderContext = createContext<CmsRenderData>({});

export function useCmsRender(): CmsRenderData {
  return useContext(CmsRenderContext);
}
