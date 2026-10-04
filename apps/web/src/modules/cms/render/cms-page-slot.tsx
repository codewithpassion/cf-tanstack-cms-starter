// biome-ignore-all lint/suspicious/noThenProperty: a synchronously resolving thenable, so React.lazy doesn't suspend for an already-loaded module.
// biome-ignore-all lint/suspicious/noReturnAssign: memoised dynamic import.
import { lazy, Suspense } from "react";

import type { CmsPageData } from "./cms-result";

/**
 * `CmsPage` for routes that render either a CMS page or their own content. The renderer, block
 * registry and Zod load only when a CMS page is shown: the loader awaits `preloadCmsPage()` first,
 * so on the server (and on client navigations) the lazy component is already resolved and renders
 * inline without suspending. During hydration it may suspend once; React keeps the server HTML
 * until the chunk arrives.
 */

type CmsPageModule = typeof import("./cms-page");
let loaded: CmsPageModule | undefined;

const load = async () => (loaded ??= await import("./cms-page"));

export async function preloadCmsPage(): Promise<void> {
  await load();
}

type Resolved = { default: CmsPageModule["CmsPage"] };

const LazyCmsPage = lazy((): Promise<Resolved> => {
  // A thenable that resolves synchronously, so React.lazy doesn't suspend for an already-loaded module.
  if (loaded) {
    const value: Resolved = { default: loaded.CmsPage };
    return {
      then: (resolve: (v: Resolved) => unknown) => resolve(value),
    } as Promise<Resolved>;
  }
  return load().then((m) => ({ default: m.CmsPage }));
});

export function CmsPageSlot(props: CmsPageData) {
  return (
    <Suspense fallback={null}>
      <LazyCmsPage {...props} />
    </Suspense>
  );
}
