/** Shared test data for CMS unit tests. Not imported by app code. */
import { type AnyBlockDef, getBlockDef } from "./blocks/registry";
import { richTextFromString } from "./richtext/schema";
import type { SiteConfig } from "./site/config";
import type { PageDoc, PageSeo } from "./types";

export const MEDIA_ID = `${"a".repeat(64)}.jpg`;

export function sampleSeo(): PageSeo {
  return {
    title: "Sample page",
    description: "A sample page.",
    slug: "services/sample",
    robots: { index: true, follow: true },
    sitemap: { include: true },
    social: {},
    schema: { pageType: "WebPage" },
    llms: { include: true },
  };
}

export function sampleDoc(): PageDoc {
  return {
    _schema: 1,
    seo: sampleSeo(),
    blocks: [
      {
        _key: "hero1",
        _type: "hero",
        _v: 1,
        props: {
          variant: "page",
          eyebrow: "Sample",
          heading: "Hello CMS",
          lead: "Lead text.",
          primary: { label: "Contact", href: "/contact" },
        },
        style: {
          padding: { mobile: { top: 48 } },
          colors: { heading: { token: "accent" } },
          elements: { heading: { size: { mobile: "lg" } } },
        },
      },
      {
        _key: "grid1",
        _type: "featureGrid",
        _v: 1,
        props: {
          heading: "Features",
          columns: 3,
          variant: "cards",
          items: [
            {
              _key: "a",
              icon: "brain",
              title: "One",
              body: richTextFromString("First."),
            },
            { _key: "b", title: "Two", body: richTextFromString("Second.") },
          ],
        },
        style: { hide: { tablet: true }, border: "cyber" },
      },
      {
        _key: "faq1",
        _type: "faq",
        _v: 1,
        props: {
          heading: "Questions",
          items: [
            {
              _key: "q1",
              q: "What is it?",
              a: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "It is " },
                      {
                        type: "text",
                        text: "great",
                        marks: [{ type: "bold" }],
                      },
                      { type: "text", text: "." },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        _key: "cta1",
        _type: "cta",
        _v: 1,
        props: {
          heading: "Ready?",
          primary: { label: "Book", href: "https://other.example.org/book" },
        },
      },
    ],
  };
}

/** The registered definition of `type`, throwing when there is none. */
export function blockDef(type: string): AnyBlockDef {
  const def = getBlockDef(type);
  if (!def) {
    throw new Error(`No block type "${type}"`);
  }
  return def;
}

/** The site config the tests build against. */
export const TEST_CONFIG: SiteConfig = {
  name: "Example Site",
  origin: "https://example.com",
  gscProperty: "sc-domain:example.com",
  timeZone: "UTC",
};
