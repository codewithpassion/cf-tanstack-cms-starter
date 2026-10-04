import type { SiteConfig } from "./config";
import type { PublicSiteSeo } from "./types";

/**
 * The site-wide SEO values used when no site doc is published (the site doc's SEO defaults otherwise). Its own module so the public entry chunk (route `head`s) doesn't carry the
 * nav and footer defaults (defaults.ts); the organization default lives there too, as heads don't
 * use it.
 */
export function defaultSeo(config: Pick<SiteConfig, "name">): PublicSiteSeo {
  return {
    titleTemplate: `%s | ${config.name}`,
    // public/og-image.jpg is a plain placeholder card (1200×630) until a default share image is set in the site doc.
    defaultShareImage: { url: "/og-image.jpg", alt: "" },
    twitterCard: "summary_large_image",
  };
}
