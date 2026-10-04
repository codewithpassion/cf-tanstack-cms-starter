// biome-ignore-all lint/security/noDangerouslySetInnerHtml: JSON-LD is serialised with safeJsonLd, which escapes `<`, `>` and `&`.
// biome-ignore-all lint/suspicious/noArrayIndexKey: the JSON-LD nodes are a fixed list built per render, never reordered.
import { safeJsonLd } from "@repo/cms-core/json-ld";
import { buildJsonLd } from "@repo/cms-core/render/page-json-ld";

import { Footer } from "#/components/footer";
import { Navigation } from "#/components/navigation";

import { useSiteConfig } from "../site/site-context";
import type { CmsPageData } from "./cms-result";
import { PageRenderer } from "./page-renderer";
import { PostArticle, PreviewBanner } from "./post-article";
import { CmsRenderContext } from "./render-context";

/**
 * A published CMS page in the public site's shell (the site doc's nav and footer, site/use-site.tsx),
 * unless the page sets `chrome: "none"` (cms-core types.ts PageChrome); a draft preview gets a
 * banner. `overflow-x-clip`, not `hidden`: a hidden overflow would make this wrapper the scroll
 * container and stop the nav from sticking. A post (a doc with `post` metadata) gets the post
 * layout instead (post-article.tsx).
 */
export function CmsPage(props: CmsPageData) {
  const { doc, path, parents, posts, preview } = props;
  const config = useSiteConfig();
  if (doc.post) {
    return <PostArticle {...props} post={doc.post} />;
  }
  const siteChrome = doc.chrome !== "none";
  return (
    <div className="overflow-x-clip">
      {buildJsonLd(doc, path, config, parents).map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(node) }}
        />
      ))}
      {siteChrome && <Navigation />}
      <CmsRenderContext.Provider value={{ posts }}>
        <PageRenderer doc={doc} />
      </CmsRenderContext.Provider>
      {siteChrome && <Footer />}
      {!!preview && <PreviewBanner />}
    </div>
  );
}
