import type { SiteConfig } from "./config";
import { defaultSeo } from "./seo-defaults";
import type {
  PublicSite,
  SiteDoc,
  SiteFooter,
  SiteNav,
  SiteSeo,
} from "./types";

/**
 * The built-in nav, footer and SEO values. The public site renders these whenever KV has no valid
 * site doc. A minimal starting point, edited in /admin/site (the starter content import replaces
 * them with a fuller set). Data only. The SEO defaults are a module of their own (seo-defaults.ts):
 * route `head`s in the public entry chunk need only those, and this module then ships with the
 * Navigation/Footer chunk instead.
 */

const link = (_key: string, label: string, href: string) => ({
  _key,
  label,
  href,
});

export function defaultNav(): SiteNav {
  return {
    links: [link("nav-home", "Home", "/"), link("nav-blog", "Blog", "/blog")],
    cta: { label: "Get in touch", href: "/contact" },
  };
}

export function defaultFooter(config: Pick<SiteConfig, "name">): SiteFooter {
  return {
    tagline: "Edit me: a short line about the site.",
    location: "Edit me: city, country",
    columns: [
      {
        _key: "col-site",
        title: "Site",
        links: [link("fs-home", "Home", "/"), link("fs-blog", "Blog", "/blog")],
      },
    ],
    // No items: the footer leaves the column out until some are added.
    highlights: { title: "About", items: [] },
    copyright: `${config.name}. All rights reserved.`,
    legalLinks: [],
  };
}

/** The organization's URLs must be https (site/schema.ts). A plain-http origin (`bun run dev` on localhost) would make the default site settings unsaveable, so it gets a placeholder until a real https origin is set. */
const PLACEHOLDER_ORIGIN = "https://example.com";

export function defaultOrganization(
  config: Pick<SiteConfig, "name" | "origin">
): SiteSeo["organization"] {
  const origin = config.origin.startsWith("https://")
    ? config.origin
    : PLACEHOLDER_ORIGIN;
  return {
    name: config.name,
    url: origin,
    // No logo file by default: the default share card is the only https image the site serves.
    logo: `${origin}/og-image.jpg`,
    sameAs: [],
  };
}

export function defaultSiteDoc(config: SiteConfig): SiteDoc {
  const seo = defaultSeo(config);
  return {
    _schema: 1,
    nav: defaultNav(),
    footer: defaultFooter(config),
    seo: {
      titleTemplate: seo.titleTemplate,
      defaultShareImage: seo.defaultShareImage,
      organization: defaultOrganization(config),
      twitterCard: seo.twitterCard,
    },
    swatches: [],
  };
}

export function defaultPublicSite(config: SiteConfig): PublicSite {
  return {
    nav: defaultNav(),
    footer: defaultFooter(config),
    seo: defaultSeo(config),
  };
}

/** The public part of a site doc (what the root loader sends to the browser): no swatches, no organization. */
export function publicSite(doc: SiteDoc): PublicSite {
  const { titleTemplate, defaultShareImage, twitterCard } = doc.seo;
  return {
    nav: doc.nav,
    footer: doc.footer,
    seo: { titleTemplate, defaultShareImage, twitterCard },
  };
}
