import { createBlock } from "./blocks/registry";
import { newPageDoc, newPostDoc } from "./new-docs";
import { postBlockStyle } from "./posts";
import type { RichTextDoc } from "./richtext/schema";
import type { SiteConfig } from "./site/config";
import { defaultSiteDoc } from "./site/defaults";
import type { SiteDoc } from "./site/types";
import type { Block, PageDoc, PageKind } from "./types";

/**
 * Starter content: pure builders for the pages, posts and site settings a new site starts with
 * (lorem ipsum, meant to be replaced). The importer in `@repo/services` writes them through the
 * pages and site services. Nothing here does I/O; images arrive as media ids the importer got
 * from uploading `STARTER_IMAGES`.
 */

/** The placeholder illustrations the importer uploads to the media library. */
export const STARTER_IMAGE_KEYS = ["team", "post1", "post2", "post3"] as const;
export type StarterImageKey = (typeof STARTER_IMAGE_KEYS)[number];

export type StarterImage = { mediaId: string; width: number; height: number };
export type StarterMedia = Record<StarterImageKey, StarterImage>;

export type StarterPage = {
  kind: PageKind;
  /** "" is the home page. */
  slug: string;
  title: string;
  doc: PageDoc;
};

const LOREM_SHORT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
const LOREM_BODY =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";
const LOREM_MORE =
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

const text = (value: string) => ({ type: "text" as const, text: value });
const para = (value: string) => ({
  type: "paragraph" as const,
  content: [text(value)],
});
const heading = (value: string, level: 2 | 3 = 2) => ({
  type: "heading" as const,
  attrs: { level },
  content: [text(value)],
});
const bullets = (...points: string[]) => ({
  type: "bulletList" as const,
  content: points.map((point) => ({
    type: "listItem" as const,
    content: [para(point)],
  })),
});
const rich = (...content: RichTextDoc["content"]): RichTextDoc => ({
  type: "doc",
  content,
});
const prose = (value: string): RichTextDoc => rich(para(value));

const block = (
  type: Parameters<typeof createBlock>[0],
  key: string,
  props: Record<string, unknown>
): Block => createBlock(type, { _key: key, props });

function pageDoc(
  title: string,
  slug: string,
  description: string,
  pageType: PageDoc["seo"]["schema"]["pageType"],
  blocks: Block[]
): PageDoc {
  const doc = newPageDoc(title, slug);
  doc.seo.description = description;
  doc.seo.schema.pageType = pageType;
  doc.blocks = blocks;
  return doc;
}

const faqItems = [
  {
    _key: "q1",
    q: "What is included in each plan?",
    a: prose(`${LOREM_SHORT} ${LOREM_MORE}`),
  },
  {
    _key: "q2",
    q: "Can I change plans later?",
    a: prose(LOREM_BODY),
  },
  {
    _key: "q3",
    q: "How does billing work?",
    a: prose(`${LOREM_BODY} ${LOREM_MORE}`),
  },
  {
    _key: "q4",
    q: "Do you offer support?",
    a: prose(LOREM_SHORT),
  },
];

const pricingPlans = [
  {
    _key: "starter",
    name: "Starter",
    price: "$0",
    unit: "per month",
    inclusions: ["One project", "Community support", "Basic analytics"].map(
      (t, i) => ({ _key: `i${i}`, text: t })
    ),
    cta: { label: "Get started", href: "/contact" },
  },
  {
    _key: "team",
    name: "Team",
    price: "$29",
    unit: "per seat, per month",
    highlight: true,
    inclusions: [
      "Unlimited projects",
      "Priority support",
      "Advanced analytics",
      "Team permissions",
    ].map((t, i) => ({ _key: `i${i}`, text: t })),
    cta: { label: "Start free trial", href: "/contact" },
  },
  {
    _key: "scale",
    name: "Scale",
    price: "$99",
    unit: "per seat, per month",
    inclusions: [
      "Everything in Team",
      "Single sign-on",
      "Audit log",
      "Dedicated manager",
    ].map((t, i) => ({ _key: `i${i}`, text: t })),
    cta: { label: "Talk to us", href: "/contact" },
  },
];

function homeDoc(): PageDoc {
  return pageDoc(
    "Home",
    "",
    "A short description of the site for search results. Replace this with your own.",
    "WebPage",
    [
      block("hero", "hero", {
        variant: "page",
        eyebrow: "Now in public beta",
        heading: "Build something people love, faster",
        headingAccent: "people love",
        lead: LOREM_BODY,
        primary: { label: "Get started", href: "/contact" },
        secondary: { label: "See pricing", href: "/pricing" },
      }),
      block("logos", "logos", {
        eyebrow: "Trusted by teams everywhere",
        heading: "Companies of every size ship with us",
        items: ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark"].map(
          (name, i) => ({
            _key: `l${i}`,
            name,
            icon: (
              ["rocket", "building", "code", "shield", "zap", "target"] as const
            )[i],
          })
        ),
      }),
      block("featureGrid", "features", {
        eyebrow: "Features",
        heading: "Everything you need, nothing you don't",
        intro: LOREM_SHORT,
        columns: 3,
        variant: "cards",
        items: [
          ["zap", "Fast by default"],
          ["shield", "Secure and private"],
          ["workflow", "Simple workflows"],
          ["chart", "Clear analytics"],
          ["users", "Built for teams"],
          ["sparkles", "Thoughtful details"],
        ].map(([icon, title], i) => ({
          _key: `f${i}`,
          icon,
          title,
          body: prose(LOREM_SHORT),
        })),
      }),
      block("stats", "stats", {
        items: [
          { _key: "s1", value: "10k+", label: "Active teams" },
          { _key: "s2", value: "99.9%", label: "Uptime" },
          { _key: "s3", value: "4.9/5", label: "Average rating" },
          { _key: "s4", value: "24/7", label: "Support" },
        ],
      }),
      block("steps", "steps", {
        eyebrow: "How it works",
        heading: "Up and running in three steps",
        items: [
          ["01", "Create your account"],
          ["02", "Connect your tools"],
          ["03", "Launch and learn"],
        ].map(([label, title], i) => ({
          _key: `st${i}`,
          label,
          title,
          body: rich(
            para(LOREM_SHORT),
            bullets("Lorem ipsum", "Dolor sit amet")
          ),
        })),
      }),
      block("testimonial", "testimonial", {
        eyebrow: "Testimonials",
        heading: "Loved by the people who use it",
        items: [
          {
            _key: "t1",
            quote: `${LOREM_BODY} ${LOREM_MORE}`,
            name: "Jordan Lee",
            role: "Head of Product",
            company: "Acme Inc.",
          },
        ],
        autoplay: 0,
      }),
      block("pricing", "pricing", {
        eyebrow: "Pricing",
        heading: "Simple, transparent pricing",
        intro: LOREM_SHORT,
        plans: pricingPlans,
        note: "Prices are placeholders. Replace them with your own.",
      }),
      block("postList", "posts", {
        eyebrow: "Blog",
        heading: "Latest from the blog",
        limit: 3,
        viewAllLabel: "All articles",
      }),
      block("faq", "faq", {
        eyebrow: "FAQ",
        heading: "Frequently asked questions",
        items: faqItems,
      }),
      block("cta", "cta", {
        variant: "large",
        heading: "Ready to get started?",
        body: LOREM_SHORT,
        primary: { label: "Get in touch", href: "/contact" },
        secondary: { label: "View pricing", href: "/pricing" },
      }),
    ]
  );
}

function aboutDoc(media: StarterMedia): PageDoc {
  return pageDoc(
    "About",
    "about",
    "Who we are and what we care about. Replace this with your own story.",
    "AboutPage",
    [
      block("hero", "hero", {
        variant: "minimal",
        eyebrow: "About us",
        heading: "A small team with a clear purpose",
        lead: LOREM_SHORT,
      }),
      block("richText", "story", {
        body: rich(
          heading("Our story"),
          para(`${LOREM_BODY} ${LOREM_MORE}`),
          para(LOREM_BODY),
          heading("What we believe"),
          bullets(
            "Lorem ipsum dolor sit amet",
            "Consectetur adipiscing elit",
            "Sed do eiusmod tempor"
          )
        ),
      }),
      block("image", "team", {
        mediaId: media.team.mediaId,
        alt: "Abstract illustration of overlapping shapes in indigo and grey",
        caption: "Placeholder illustration. Replace it from the media library.",
        width: media.team.width,
        height: media.team.height,
      }),
      block("stats", "stats", {
        eyebrow: "By the numbers",
        items: [
          { _key: "s1", value: "2019", label: "Founded" },
          { _key: "s2", value: "40+", label: "Team members" },
          { _key: "s3", value: "12", label: "Countries" },
        ],
      }),
      block("callout", "callout", {
        eyebrow: "Note",
        heading: "This is placeholder content",
        body: prose(
          "Edit this page in the admin editor, or ask the agent to rewrite it."
        ),
      }),
    ]
  );
}

function pricingDoc(): PageDoc {
  return pageDoc(
    "Pricing",
    "pricing",
    "Plans and pricing. Replace these placeholder figures with your own.",
    "WebPage",
    [
      block("hero", "hero", {
        variant: "minimal",
        eyebrow: "Pricing",
        heading: "Plans for every stage",
        lead: LOREM_SHORT,
      }),
      block("pricing", "pricing", {
        heading: "Choose a plan",
        plans: pricingPlans,
        note: "Prices are placeholders. Replace them with your own.",
      }),
      block("faq", "faq", {
        eyebrow: "FAQ",
        heading: "Pricing questions",
        items: faqItems,
      }),
      block("cta", "cta", {
        heading: "Still deciding?",
        body: LOREM_SHORT,
        primary: { label: "Talk to us", href: "/contact" },
      }),
    ]
  );
}

function contactDoc(): PageDoc {
  return pageDoc(
    "Contact",
    "contact",
    "How to get in touch. Replace this with your own contact details.",
    "ContactPage",
    [
      block("hero", "hero", {
        variant: "minimal",
        eyebrow: "Contact",
        heading: "Let's talk",
        lead: LOREM_SHORT,
      }),
      block("richText", "intro", {
        body: rich(
          para(LOREM_BODY),
          heading("Write to us"),
          para("hello@example.com")
        ),
      }),
      block("checklist", "ready", {
        eyebrow: "Before you write",
        heading: "What to include",
        items: [
          "A few lines about your project",
          "Your timeline and budget range",
          "Anyone else who should be in the conversation",
        ].map((t, i) => ({ _key: `c${i}`, body: prose(t) })),
        note: prose("We usually reply within one business day."),
      }),
      block("cta", "cta", {
        variant: "compact",
        body: "Prefer to look around first?",
        primary: { label: "See pricing", href: "/pricing" },
      }),
    ]
  );
}

type PostSpec = {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  tags: string[];
  publishedAt: string;
  image: StarterImageKey;
  alt: string;
};

const POSTS: PostSpec[] = [
  {
    slug: "welcome-to-the-blog",
    title: "Welcome to the blog",
    excerpt: LOREM_BODY,
    category: "News",
    tags: ["welcome", "news"],
    publishedAt: "2026-01-12",
    image: "post1",
    alt: "Abstract indigo gradient with soft shapes",
  },
  {
    slug: "how-we-work",
    title: "How we work",
    excerpt: LOREM_SHORT,
    category: "Company",
    tags: ["process", "team"],
    publishedAt: "2026-02-03",
    image: "post2",
    alt: "Abstract grey and indigo bars",
  },
  {
    slug: "what-is-next",
    title: "What is next",
    excerpt: LOREM_MORE,
    category: "Product",
    tags: ["roadmap"],
    publishedAt: "2026-03-18",
    image: "post3",
    alt: "Abstract indigo circles on a light background",
  },
];

function postDoc(spec: PostSpec, media: StarterMedia): PageDoc {
  const slug = `blog/${spec.slug}`;
  const doc = newPostDoc({
    title: spec.title,
    slug,
    category: spec.category,
    author: "The Team",
  });
  doc.seo.description = spec.excerpt;
  if (!doc.post) {
    throw new Error("newPostDoc returned a doc without post metadata");
  }
  // Dropping `publishedAtAuto` keeps each post's date when it is published.
  const { publishedAtAuto: _auto, ...post } = doc.post;
  doc.post = {
    ...post,
    excerpt: spec.excerpt,
    tags: spec.tags,
    publishedAt: spec.publishedAt,
    featuredImage: { mediaId: media[spec.image].mediaId, alt: spec.alt },
  };
  const body = (key: string, ...content: RichTextDoc["content"]): Block =>
    createBlock("richText", {
      _key: key,
      props: { body: rich(...content) },
      style: postBlockStyle("richText"),
    });
  doc.blocks = [
    body(
      "intro",
      para(`${LOREM_BODY} ${LOREM_MORE}`),
      para(LOREM_BODY),
      heading("Lorem ipsum dolor"),
      para(`${LOREM_MORE} ${LOREM_SHORT}`),
      bullets("Sit amet consectetur", "Adipiscing elit", "Sed do eiusmod")
    ),
    createBlock("callout", {
      _key: "callout",
      props: {
        body: prose("Placeholder article. Edit or delete it in the admin."),
      },
      style: postBlockStyle("callout"),
    }),
    body(
      "outro",
      heading("Duis aute irure"),
      para(`${LOREM_BODY} ${LOREM_MORE}`)
    ),
  ];
  return doc;
}

/** Every starter page and post, in the order they are created. */
export function starterPages(media: StarterMedia): StarterPage[] {
  const pages: StarterPage[] = [
    { kind: "page", slug: "", title: "Home", doc: homeDoc() },
    { kind: "page", slug: "about", title: "About", doc: aboutDoc(media) },
    { kind: "page", slug: "pricing", title: "Pricing", doc: pricingDoc() },
    { kind: "page", slug: "contact", title: "Contact", doc: contactDoc() },
  ];
  for (const spec of POSTS) {
    pages.push({
      kind: "post",
      slug: `blog/${spec.slug}`,
      title: spec.title,
      doc: postDoc(spec, media),
    });
  }
  return pages;
}

/** Nav, footer, brand swatches and SEO defaults: the default site doc with fuller starter values. */
export function starterSiteDoc(config: SiteConfig): SiteDoc {
  const base = defaultSiteDoc(config);
  const link = (key: string, label: string, href: string) => ({
    _key: key,
    label,
    href,
  });
  return {
    ...base,
    nav: {
      links: [
        link("nav-home", "Home", "/"),
        link("nav-about", "About", "/about"),
        link("nav-pricing", "Pricing", "/pricing"),
        link("nav-blog", "Blog", "/blog"),
        link("nav-contact", "Contact", "/contact"),
      ],
      cta: { label: "Get started", href: "/contact" },
    },
    footer: {
      tagline: "A short line about what this site does.",
      location: "City, Country",
      columns: [
        {
          _key: "col-product",
          title: "Product",
          links: [
            link("fp-home", "Home", "/"),
            link("fp-pricing", "Pricing", "/pricing"),
            link("fp-blog", "Blog", "/blog"),
          ],
        },
        {
          _key: "col-company",
          title: "Company",
          links: [
            link("fc-about", "About", "/about"),
            link("fc-contact", "Contact", "/contact"),
          ],
        },
      ],
      highlights: {
        title: "About",
        items: [{ _key: "h1", text: LOREM_SHORT }],
      },
      copyright: `${config.name}. All rights reserved.`,
      legalLinks: [],
    },
    swatches: [
      { _key: "sw-indigo", hex: "#4f46e5", name: "Indigo" },
      { _key: "sw-sky", hex: "#0ea5e9", name: "Sky" },
      { _key: "sw-zinc", hex: "#18181b", name: "Zinc 900" },
      { _key: "sw-slate", hex: "#f4f4f5", name: "Zinc 100" },
    ],
  };
}
