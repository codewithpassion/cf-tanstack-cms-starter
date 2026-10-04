// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
import { mediaUrl } from "../media";
import type { SiteConfig } from "../site/config";
import { defaultSeo } from "../site/seo-defaults";
import type { PublicSiteSeo } from "../site/types";
import type { PageDoc } from "../types";

/**
 * Head tags for a CMS page, in the same shape and format as the
 * hand-written routes. Route `head`s import this, so it must stay free of Zod and the block
 * registry; the JSON-LD is built by `CmsPage` (render/page-json-ld.ts). The title template,
 * default share image and twitter:card come from the site doc's SEO defaults (`site`); without
 * one, `defaultSeo(config)`.
 */

/** Absolute URL of a path; the home page has no trailing slash, as in the existing canonicals. */
export function absoluteUrl(
  config: Pick<SiteConfig, "origin">,
  path: string
): string {
  return path === "/" ? config.origin : `${config.origin}${path}`;
}

type MetaTag =
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

/** The page's `<title>`: the site's title template around the SEO title, unless the title is exact. */
export function pageTitle(
  seo: Pick<PageDoc["seo"], "title" | "titleExact">,
  site: PublicSiteSeo
): string {
  return seo.titleExact
    ? seo.title
    : site.titleTemplate.replace("%s", () => seo.title);
}

/** The site's default share image as an absolute URL, with alt text and size when known. */
export function defaultShareImage(
  config: SiteConfig,
  site: PublicSiteSeo = defaultSeo(config)
): {
  url: string;
  alt: string;
  width?: number;
  height?: number;
} {
  const { mediaId, url, alt, width, height } = site.defaultShareImage;
  const src = mediaId ? mediaUrl(mediaId) : url;
  return {
    url: src.startsWith("/") ? `${config.origin}${src}` : src,
    alt,
    width,
    height,
  };
}

/** The meta description: `seo.description`, else (for a post) its excerpt. */
export function pageDescription(doc: Pick<PageDoc, "seo" | "post">): string {
  return doc.seo.description || doc.post?.excerpt || "";
}

/** The page's share image: `seo.social.image`, else (for a post) its featured image; none means the site default. */
export function shareImageOf(
  doc: Pick<PageDoc, "seo" | "post">
):
  | { mediaId: string; alt: string; width?: number; height?: number }
  | undefined {
  return doc.seo.social.image ?? doc.post?.featuredImage;
}

export function buildHead(
  doc: PageDoc,
  path: string,
  config: SiteConfig,
  site: PublicSiteSeo = defaultSeo(config)
): { meta: MetaTag[]; links: { rel: string; href: string }[] } {
  const { seo } = doc;
  const title = pageTitle(seo, site);
  const url = seo.canonical ?? absoluteUrl(config, path);
  const shareTitle = seo.social.title ?? title;
  // A post without its own meta description uses its excerpt (not in the source, which left it empty).
  const description = pageDescription(doc);
  const shareDescription = seo.social.description ?? description;
  // The page's share image, else a post's featured image (not in the source), else the site default.
  // Width and height are the media's own, stored when the image was picked; a doc without them
  // (picked before they were stored, a featured image, or a fallback URL) gets no size tags rather
  // than a guess.
  const image = shareImageOf(doc);
  const shown = image
    ? { ...image, url: `${config.origin}${mediaUrl(image.mediaId)}` }
    : defaultShareImage(config, site);
  const imageUrl = shown.url;
  const imageAlt = shown.alt;
  const imageDetails: MetaTag[] = [
    ...(shown.width && shown.height
      ? [
          { property: "og:image:width", content: String(shown.width) },
          { property: "og:image:height", content: String(shown.height) },
        ]
      : []),
    ...(image || imageAlt
      ? [{ property: "og:image:alt", content: imageAlt }]
      : []),
  ];

  return {
    meta: [
      { title },
      { name: "description", content: description },
      {
        name: "robots",
        content: `${seo.robots.index ? "index" : "noindex"}, ${seo.robots.follow ? "follow" : "nofollow"}`,
      },
      // biome-ignore lint/suspicious/noUnnecessaryConditions: `post` is optional (only posts have it).
      { name: "author", content: doc.post?.author ?? config.name },
      {
        property: "og:type",
        content: seo.schema.pageType === "Article" ? "article" : "website",
      },
      { property: "og:title", content: shareTitle },
      { property: "og:description", content: shareDescription },
      { property: "og:url", content: url },
      { property: "og:image", content: imageUrl },
      ...imageDetails,
      { name: "twitter:card", content: site.twitterCard },
      { name: "twitter:title", content: shareTitle },
      { name: "twitter:description", content: shareDescription },
      { name: "twitter:image", content: imageUrl },
      ...(imageAlt || image
        ? [{ name: "twitter:image:alt", content: imageAlt }]
        : []),
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
