// biome-ignore-all lint/security/noDangerouslySetInnerHtml: JSON-LD is serialised with safeJsonLd, which escapes `<`, `>` and `&`.
// biome-ignore-all lint/suspicious/noArrayIndexKey: the JSON-LD nodes are a fixed list built per render, never reordered.
import { safeJsonLd } from "@repo/cms-core/json-ld";
import { buildJsonLd } from "@repo/cms-core/render/page-json-ld";
import type { PostMeta } from "@repo/cms-core/types";
import { motion } from "framer-motion";

import { Footer } from "#/components/footer";
import { Navigation } from "#/components/navigation";

import { useSiteConfig } from "../site/site-context";
import type { CmsPageData } from "./cms-result";
import { PageRenderer } from "./page-renderer";
import { PostLayout } from "./post-layout";
import { CmsRenderContext } from "./render-context";

/** Where a post's closing call to action sends readers (the starter content seeds a Contact page). */
const CONTACT_PATH = "/contact";

/**
 * A published blog post (docs/cms-plan.md §3.8): the site chrome, the post's article column
 * (post-layout.tsx), then the closing call to action every post ends with. That is part of the
 * layout, not a block, so every post keeps it. `overflow-x-clip`, not `hidden`: a hidden overflow
 * would make this wrapper the scroll container and stop the nav from sticking.
 */
export function PostArticle({
  doc,
  post,
  path,
  parents,
  posts,
  preview,
}: CmsPageData & { post: PostMeta }) {
  const config = useSiteConfig();
  return (
    <div className="bg-background text-foreground font-sans overflow-x-clip">
      {buildJsonLd(doc, path, config, parents).map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(node) }}
        />
      ))}

      <Navigation />

      <PostLayout doc={doc} post={post}>
        <CmsRenderContext.Provider value={{ posts }}>
          <PageRenderer doc={doc} />
        </CmsRenderContext.Provider>
      </PostLayout>

      <section className="py-20 relative">
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            className="cms-card bg-muted p-12 text-center max-w-4xl mx-auto"
            initial={{ y: 50, opacity: 0 }}
            whileInView={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
          >
            <h2 className="font-heading font-semibold tracking-tight text-3xl md:text-4xl text-primary mb-6">
              Have a question about this?
            </h2>
            <p className="text-muted-foreground font-sans text-lg mb-8 max-w-2xl mx-auto">
              Tell us what you're working on and we'll get back to you.
            </p>
            <motion.a
              href={CONTACT_PATH}
              className="inline-block rounded-md bg-primary text-primary-foreground font-medium px-6 py-3 shadow-soft hover:bg-primary/90 transition-colors"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              Get in touch
            </motion.a>
          </motion.div>
        </div>
      </section>

      <Footer />
      {!!preview && <PreviewBanner />}
    </div>
  );
}

/** Shown on a draft preview (load-page.ts) so nobody mistakes it for the live page. */
export function PreviewBanner() {
  return (
    <div
      role="status"
      data-testid="preview-banner"
      className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 rounded-full border border-border bg-foreground px-4 py-2 font-sans text-sm text-background shadow-lift"
    >
      Draft preview: not published
    </div>
  );
}
