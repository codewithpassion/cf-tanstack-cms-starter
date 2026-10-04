// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
import { slugToPath } from "../paths";
import type { SiteConfig } from "../site/config";
import { defaultSeo } from "../site/seo-defaults";
import type { PublicSiteSeo } from "../site/types";
import type { PageDoc, PageKind } from "../types";
import { pageTitle } from "./build-head";
import {
  effectiveSeo,
  runSeoChecks,
  type SeoContext,
  type SeoOtherPage,
  seoScore,
} from "./checks";
import type { SeoOverviewIssue, SeoOverviewRow } from "./overview-table";

/**
 * Shapes every page's draft into /admin/seo rows: effective SEO values,
 * the checklist score and the duplicate flags. Pure; seo-fns.ts feeds it from D1.
 */

export type SeoPageInput = {
  id: string;
  kind: PageKind;
  slug: string;
  title: string;
  status: "draft" | "published" | "archived";
  doc: PageDoc;
};

export type MediaSizes = NonNullable<SeoContext["media"]>;

/** What the uniqueness checks compare against: every non-archived page's full title and description. */
export function otherPagesFrom(
  pages: SeoPageInput[],
  config: SiteConfig,
  site?: PublicSiteSeo
): SeoOtherPage[] {
  return pages
    .filter((p) => p.status !== "archived")
    .map((p) => {
      const eff = effectiveSeo(p.doc, config, site);
      return {
        id: p.id,
        slug: p.doc.seo.slug,
        title: eff.title,
        description: p.doc.seo.description.trim(),
      };
    });
}

/** A draft's SEO fields the uniqueness checks need, as seo-fns.ts reads them from D1 without the whole document. */
export type DraftSeoSummary = {
  id: string;
  slug: string;
  title: string;
  titleExact: boolean;
  description: string;
};

/** `otherPagesFrom` for one page from its `DraftSeoSummary`: the same full title (template applied) and description. */
export function otherPageFromSummary(
  p: DraftSeoSummary,
  config: SiteConfig,
  site: PublicSiteSeo = defaultSeo(config)
): SeoOtherPage {
  const title = pageTitle({ title: p.title, titleExact: p.titleExact }, site);
  return { id: p.id, slug: p.slug, title, description: p.description.trim() };
}

/** `site`: the published site's SEO defaults (title template, default share image); the built-in ones when absent. */
export function buildSeoOverview(
  pages: SeoPageInput[],
  media: MediaSizes,
  config: SiteConfig,
  site?: PublicSiteSeo
): SeoOverviewRow[] {
  const live = pages.filter(
    (p): p is SeoPageInput & { status: "draft" | "published" } =>
      p.status !== "archived"
  );
  const others = otherPagesFrom(live, config, site);
  return live.map((p) => {
    const eff = effectiveSeo(p.doc, config, site);
    const checks = runSeoChecks(p.doc, {
      config,
      pageId: p.id,
      others,
      media,
      kind: p.kind,
      isHome: p.slug === "",
      site,
    });
    const issues: SeoOverviewIssue[] = checks
      .flatMap((c) =>
        c.status === "fail" || c.status === "warn"
          ? [{ id: c.id, label: c.label, status: c.status, message: c.message }]
          : []
      )
      .sort((a, b) =>
        a.status === b.status ? 0 : a.status === "fail" ? -1 : 1
      );
    const size = eff.image.mediaId ? media[eff.image.mediaId] : undefined;
    return {
      id: p.id,
      kind: p.kind,
      slug: p.doc.seo.slug,
      path: slugToPath(p.doc.seo.slug),
      pageTitle: p.title,
      status: p.status,
      seoTitle: eff.title,
      description: p.doc.seo.description,
      index: p.doc.seo.robots.index,
      sitemap: p.doc.seo.robots.index && p.doc.seo.sitemap.include,
      shareImage: {
        src: eff.image.src,
        isDefault: eff.image.isDefault,
        width: size?.width ?? null,
        height: size?.height ?? null,
      },
      score: seoScore(checks),
      fails: issues.filter((i) => i.status === "fail").length,
      warns: issues.filter((i) => i.status === "warn").length,
      duplicateTitle: checks.some(
        (c) => c.id === "title-unique" && c.status === "fail"
      ),
      duplicateDescription: checks.some(
        (c) => c.id === "description-unique" && c.status === "warn"
      ),
      issues,
    };
  });
}
