import { isValidSlug } from "@repo/cms-core/paths";
import { isReservedSlug } from "@repo/cms-core/reserved";
import type { SeoOtherPage } from "@repo/cms-core/seo/checks";
import {
  buildSeoOverview,
  type MediaSizes,
  otherPageFromSummary,
} from "@repo/cms-core/seo/overview";
import type { SeoOverviewRow } from "@repo/cms-core/seo/overview-table";
import type { SiteSeo } from "@repo/cms-core/site/types";
import { mediaSizes } from "@repo/db/media";
import { CmsError } from "@repo/services/cms/pages-service";
import { readSiteSeo } from "@repo/services/cms/read-site";
import type { CmsServices } from "./wiring.ts";

/**
 * What the SEO tab and /admin/seo need beyond the page service (docs/cms-plan.md §3.9): the
 * page queries of `@repo/db/pages`, media sizes and the published site's SEO defaults. Throws
 * `CmsError`, which the router wraps with `adminResult`.
 */

export type SeoDeps = Pick<CmsServices, "queries" | "db" | "kv" | "config">;

export type SeoContextResult = {
  /** Every other non-archived page's full title and description (drafts). */
  others: SeoOtherPage[];
  /** Sizes of the media the page's draft references for sharing. */
  media: MediaSizes;
  /** The slug the page is live at, or null when it isn't published. */
  liveSlug: string | null;
  /** The published site's SEO defaults (title template, default share image, organization), or the built-in ones. */
  site: SiteSeo;
};

/** What the SEO checks need beyond the document: other pages' titles/descriptions, media sizes, the live slug. */
export async function seoContext(
  d: SeoDeps,
  pageId: string
): Promise<SeoContextResult> {
  const [all, site] = await Promise.all([
    d.queries.draftSeoSummaries(),
    readSiteSeo(d.kv, d.config),
  ]);
  const self = all.find((p) => p.id === pageId);
  if (!self) {
    throw new CmsError("NOT_FOUND", `Page ${pageId} not found`);
  }
  return {
    others: all
      .filter((p) => p.id !== pageId)
      .map((p) => otherPageFromSummary(p, d.config, site)),
    media: await mediaSizes(d.db, self.shareImageId ? [self.shareImageId] : []),
    liveSlug: self.status === "published" ? self.currentSlug : null,
    site,
  };
}

/**
 * The SEO tab's slug check for an existing page: the rules publishing enforces (format, `blog/`
 * for posts only, reserved code-route slugs, another page's slug).
 */
export async function checkSeoSlug(
  d: SeoDeps,
  input: { pageId: string; slug: string }
): Promise<object> {
  const { pageId, slug } = input;
  const page = await d.queries.pageBrief(pageId);
  if (!page) {
    throw new CmsError("NOT_FOUND", `Page ${pageId} not found`);
  }
  if (!isValidSlug(slug)) {
    throw new CmsError(
      "INVALID_SLUG",
      "Use lowercase words separated by - and /, e.g. services/new-offer"
    );
  }
  const inBlog = slug.startsWith("blog/");
  if (page.kind === "page" && inBlog) {
    throw new CmsError("BAD_KIND", "Slugs under blog/ are for posts.");
  }
  if (page.kind === "post" && !inBlog) {
    throw new CmsError("BAD_KIND", "A post's slug starts with blog/.");
  }
  if (page.kind === "page" && isReservedSlug(slug)) {
    throw new CmsError(
      "SLUG_RESERVED",
      `/${slug} belongs to a page built into the site; pick another.`
    );
  }
  const taken = (await d.queries.slugOwners(slug)).find((o) => o.id !== pageId);
  if (taken) {
    throw new CmsError(
      "SLUG_TAKEN",
      `/${slug} is already used by “${taken.title}”.`
    );
  }
  return {};
}

/** Every non-archived page with its SEO checks, score and duplicate flags. */
export async function seoOverview(
  d: SeoDeps
): Promise<{ rows: SeoOverviewRow[] }> {
  const [all, site] = await Promise.all([
    d.queries.draftPages(),
    readSiteSeo(d.kv, d.config),
  ]);
  const ids = all.flatMap((p) =>
    p.doc.seo.social.image ? [p.doc.seo.social.image.mediaId] : []
  );
  if (site.defaultShareImage.mediaId) {
    ids.push(site.defaultShareImage.mediaId);
  }
  return {
    rows: buildSeoOverview(all, await mediaSizes(d.db, ids), d.config, site),
  };
}
