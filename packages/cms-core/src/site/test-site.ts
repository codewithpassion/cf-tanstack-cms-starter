import { defaultSeo } from "./seo-defaults";
import type { SiteDoc, SiteFooter, SiteNav, SiteSeo } from "./types";

/**
 * Tests only: a fuller site doc than the minimal defaults (defaults.ts), so the schema, summary and
 * render tests can index into several nav links, footer columns and legal links.
 */

const DEFAULT_SEO = defaultSeo({ name: "Example Site" });

const link = (_key: string, label: string, href: string) => ({
  _key,
  label,
  href,
});

const NAV: SiteNav = {
  links: [
    link("nav-home", "Home", "/"),
    link("nav-services", "Services", "/services"),
    link("nav-process", "Process", "/process"),
    link("nav-about", "About", "/about"),
    link("nav-blog", "Blog", "/blog"),
    link("nav-faq", "FAQ", "/faq"),
    link("nav-locations", "Locations", "/locations"),
  ],
  cta: { label: "Book a Free Call", href: "/contact" },
};

const FOOTER: SiteFooter = {
  tagline: "Human-AI Integration Experts",
  location: "Sydney, Australia",
  columns: [
    {
      _key: "col-navigation",
      title: "Navigation",
      links: [
        link("fn-home", "Home", "/"),
        link("fn-process", "Process", "/process"),
        link("fn-about", "About", "/about"),
        link("fn-services", "Services", "/services"),
        link("fn-industries", "Industries", "/industries"),
        link("fn-learn", "AI Knowledge Hub", "/learn"),
        link("fn-contact", "Contact", "/contact"),
      ],
    },
    {
      _key: "col-services",
      title: "Services",
      links: [
        link(
          "fs-automation-sprint",
          "Service One",
          "/services/automation-sprint"
        ),
        link(
          "fs-implementation",
          "AI Implementation",
          "/services/implementation"
        ),
      ],
    },
    {
      _key: "col-locations",
      title: "Locations",
      links: [
        link("fl-sydney", "Sydney", "/locations/sydney"),
        link("fl-brisbane", "Brisbane", "/locations/brisbane"),
        link("fl-melbourne", "Melbourne", "/locations/melbourne"),
        link(
          "fl-wagga-wagga",
          "Wagga Wagga & Riverina",
          "/locations/wagga-wagga"
        ),
        link("fl-all", "All Locations", "/locations"),
      ],
    },
  ],
  highlights: {
    title: "About Us",
    items: [
      {
        _key: "hl-speaker",
        text: "Regular speaker at industry events",
      },
      {
        _key: "hl-trusted",
        text: "Trusted by startups and enterprises across 3 continents",
      },
      { _key: "hl-since", text: "Helping SMEs become AI-native since 2023" },
    ],
  },
  copyright: "Example Co. All rights reserved.",
  legalLinks: [
    link("legal-privacy", "Privacy Policy", "/privacy"),
    link("legal-terms", "Terms of Service", "/terms"),
  ],
};

const ORGANIZATION: SiteSeo["organization"] = {
  name: "Example Co",
  url: "https://example.com",
  logo: "https://example.com/logo.png",
  sameAs: ["https://linkedin.com/in/janedoe", "https://twitter.com/janedoe"],
};

export const TEST_SITE: SiteDoc = {
  _schema: 1,
  nav: NAV,
  footer: FOOTER,
  seo: {
    titleTemplate: DEFAULT_SEO.titleTemplate,
    defaultShareImage: DEFAULT_SEO.defaultShareImage,
    organization: ORGANIZATION,
    twitterCard: DEFAULT_SEO.twitterCard,
  },
  swatches: [],
};
