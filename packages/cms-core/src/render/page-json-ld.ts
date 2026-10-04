// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
import { mediaUrl } from "../media";
import { postTitle } from "../posts";
import { isStaticPage } from "../reserved";
import { absoluteUrl, pageDescription } from "../seo/build-head";
import { DERIVED_JSON_LD_KEYS } from "../seo/schema";
import type { SiteConfig } from "../site/config";
import type { JsonLd, PageDoc, PostMeta } from "../types";
import { collectJsonLd } from "./json-ld";

/** On a `schema.extra` node: the derived keys it overrides (e.g. the home page's LocalBusiness keeps its business name). Never emitted. */
const OVERRIDE_KEY = "_override";

/**
 * The page's JSON-LD nodes, each with its own `@context`, for one
 * `<script type="application/ld+json">` per node (rendered in the body, like the existing routes):
 * breadcrumbs from the path, a node for `seo.schema.pageType`, the blocks' JSON-LD, then `schema.extra`.
 * The first `extra` node with the page type's `@type` extends the page node instead of adding a
 * second one: it adds keys (offers, provider, areaServed…), while the page-derived keys
 * (`DERIVED_JSON_LD_KEYS`, seo/schema.ts) keep the page's values unless the node lists them in
 * `_override`. Every node gets `"@context": "https://schema.org"`, whatever it carried.
 * `parents` are the ancestor slugs that are live CMS pages (`CmsPageData.parents`).
 */
export function buildJsonLd(
  doc: PageDoc,
  path: string,
  config: SiteConfig,
  parents: string[] = []
): JsonLd[] {
  const { seo } = doc;
  const url = seo.canonical ?? absoluteUrl(config, path);
  const page: JsonLd = doc.post
    ? articleNode(doc, doc.post, url, config)
    : {
        "@type": seo.schema.pageType,
        name: seo.title,
        ...(seo.schema.pageType === "Article" ? { headline: seo.title } : {}),
        description: seo.description,
        url,
      };
  const extra = [...(seo.schema.extra ?? [])];
  const own = extra.findIndex((node) => node["@type"] === page["@type"]);
  if (own >= 0) {
    // `own` is a found index, so the node exists (this repo sets noUncheckedIndexedAccess).
    const node = extra.splice(own, 1)[0] as JsonLd;
    const override = new Set(
      Array.isArray(node[OVERRIDE_KEY]) ? (node[OVERRIDE_KEY] as unknown[]) : []
    );
    for (const [key, value] of Object.entries(node)) {
      if (key === OVERRIDE_KEY || key === "@context") {
        continue;
      }
      if (
        (DERIVED_JSON_LD_KEYS as readonly string[]).includes(key) &&
        !override.has(key)
      ) {
        continue;
      }
      page[key] = value;
    }
  }
  const breadcrumbs = breadcrumbList(
    path,
    seo.schema.breadcrumbLabel ?? postTitle(doc),
    parents,
    config
  );
  const nodes = [
    ...(breadcrumbs ? [breadcrumbs] : []),
    page,
    ...collectJsonLd(doc),
    ...extra,
  ];
  return nodes.map(
    ({ "@context": _context, [OVERRIDE_KEY]: _override, ...node }) => ({
      "@context": "https://schema.org",
      ...node,
    })
  );
}

/**
 * A post's `Article` node, as the hand-written blog route emitted it:
 * headline (the post title), author, publisher, dates, url, and the tags as
 * `keywords`; plus the featured image when there is one. `dateModified` is the post's "updated"
 * date, else its publish date.
 */
function articleNode(
  doc: PageDoc,
  post: PostMeta,
  url: string,
  config: SiteConfig
): JsonLd {
  return {
    "@type": "Article",
    headline: postTitle(doc),
    description: pageDescription(doc),
    ...(post.featuredImage && {
      image: absoluteUrl(config, mediaUrl(post.featuredImage.mediaId)),
    }),
    author: { "@type": "Person", name: post.author },
    publisher: {
      "@type": "Organization",
      name: config.name,
      url: config.origin,
    },
    datePublished: post.publishedAt,
    dateModified: post.modifiedAt ?? post.publishedAt,
    url,
    ...(post.tags.length > 0 && { keywords: post.tags.join(", ") }),
  };
}

/**
 * Home → each ancestor that is a page (a static route or a live CMS page) → this page. Ancestors
 * with nothing at their URL are skipped. None for the home page itself.
 */
function breadcrumbList(
  path: string,
  label: string,
  parents: string[],
  config: SiteConfig
): JsonLd | null {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) {
    return null;
  }
  const items = [{ name: "Home", item: config.origin }];
  segments.forEach((segment, i) => {
    const slug = segments.slice(0, i + 1).join("/");
    const last = i === segments.length - 1;
    if (!(last || isStaticPage(slug) || parents.includes(slug))) {
      return;
    }
    items.push({
      name: last ? label : titleCase(segment),
      item: absoluteUrl(config, `/${slug}`),
    });
  });
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      ...item,
    })),
  };
}

function titleCase(segment: string): string {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
