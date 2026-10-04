/**
 * The versioned site settings document: nav, footer, SEO defaults and brand swatches. Pure types, safe for any bundle.
 * The public site gets `PublicSite` (no swatches) through the root loader; defaults.ts holds
 * today's hardcoded values, which apply whenever no site doc is published.
 */

export type SiteLink = { _key: string; label: string; href: string };

/** A top-level nav entry; `children` render as a dropdown (desktop) and an indented list (mobile). */
export type NavItem = SiteLink & { children?: SiteLink[] };

export type FooterColumn = { _key: string; title: string; links: SiteLink[] };

export type FooterHighlight = { _key: string; text: string };

export type SiteNav = {
  links: NavItem[];
  /** The highlighted button at the end of the nav ("Book a Free Call"). */
  cta: { label: string; href: string };
};

export type SiteFooter = {
  /** Under the company name, e.g. "Human-AI Integration Experts". */
  tagline: string;
  /** Above the availability line, e.g. "Sydney, Australia". */
  location: string;
  columns: FooterColumn[];
  /** The text-only column at the end ("About Us"). */
  highlights: { title: string; items: FooterHighlight[] };
  /** After "© <year> ". */
  copyright: string;
  /** Bottom bar links (Privacy Policy, Terms of Service). */
  legalLinks: SiteLink[];
};

export type TwitterCard = "summary" | "summary_large_image";

export type SiteSeo = {
  /** `%s` is replaced by the page's SEO title (unless the page's title is exact). */
  titleTemplate: string;
  /** Used when a page has no share image of its own: the library image if `mediaId` is set, else `url`. */
  defaultShareImage: {
    mediaId?: string;
    url: string;
    alt: string;
    width?: number;
    height?: number;
  };
  /** Stored for the Organization schema; not emitted yet. Admin only (not in `PublicSite`). */
  organization: { name: string; url: string; logo: string; sameAs: string[] };
  twitterCard: TwitterCard;
};

/** What page heads need from the SEO defaults: everything but the organization. */
export type PublicSiteSeo = Omit<SiteSeo, "organization">;

/** A saved custom colour, offered in the editor's colour picker beside the brand tokens. */
export type BrandSwatch = { _key: string; hex: string; name?: string };

export type SiteDoc = {
  _schema: 1;
  nav: SiteNav;
  footer: SiteFooter;
  seo: SiteSeo;
  swatches: BrandSwatch[];
};

/** What the public site needs: nav, footer and the SEO defaults heads use (no swatches, no organization). */
export type PublicSite = Pick<SiteDoc, "nav" | "footer"> & {
  seo: PublicSiteSeo;
};

/** Value of KV `site`. */
export type LiveSite = { revId: string; publishedAt: string; doc: SiteDoc };
