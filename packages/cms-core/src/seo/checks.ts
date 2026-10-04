// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; the regexes are not on a hot path.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters kept as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim; each assertion follows a length or membership check.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs), as in the source.

import { getBlockDef } from "../blocks/registry";
import { isLargeSize, rateContrast } from "../editor/style-model";
import { mediaUrl } from "../media";
import { isValidSlug, slugToPath } from "../paths";
import { buildJsonLd } from "../render/page-json-ld";
import { isReservedSlug } from "../reserved";
import type { SiteConfig } from "../site/config";
import { defaultSeo } from "../site/seo-defaults";
import type { PublicSiteSeo } from "../site/types";
import { staticPageTitles } from "../static-titles";
import { DEVICES, hiddenOn, mergeStyle } from "../style/vars";
import type { Block, Device, PageDoc, PageKind } from "../types";
import { parseBlock } from "../validate";
import { buildHead, pageDescription, shareImageOf } from "./build-head";
import {
  arialMeasure,
  DESCRIPTION_FONT_PX,
  DESCRIPTION_MAX_PX,
  type TextMeasure,
  TITLE_FONT_PX,
  TITLE_MAX_PX,
} from "./pixel-width";

/**
 * The SEO tab's deterministic checklist. Pure: the same document and
 * context always give the same results, in the browser (SEO tab, publish dialog) and on the server
 * (/admin/seo). The checklist is warn-only at publish: "fail" marks a serious problem, it never
 * blocks publishing.
 */

/** "info": nothing to fix, but worth knowing (e.g. an intentional noindex); like "na", it isn't scored. */
export type CheckStatus = "pass" | "warn" | "fail" | "info" | "na";

export type SeoCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
};

/** Another (non-archived) page, for the uniqueness checks. `title` is its full `<title>` (template applied). */
export type SeoOtherPage = {
  id: string;
  slug: string;
  title: string;
  description: string;
};

/** Everything outside the document the checks use. Every field but `config` is optional: `{ config }` skips what needs the rest. */
export type SeoContext = {
  /** The deployment's name and origin: canonical URLs, internal-link detection, static page titles. */
  config: SiteConfig;
  /** This page's id, so it isn't compared with itself in `others`. */
  pageId?: string;
  /** The other pages' titles and descriptions (seo-fns.ts `getSeoContextFn`). */
  others?: SeoOtherPage[];
  /** Pixel sizes of media the page references (the share image). */
  media?: Record<string, { width: number | null; height: number | null }>;
  /** Text measure for the meters; defaults to Arial's advance widths. */
  measure?: TextMeasure;
  /** The page's kind, for the slug rules (`blog/` is for posts; code-route slugs are reserved for pages). */
  kind?: PageKind;
  /** Whether this is the home page (its current slug is ""); only the home page may use "". */
  isHome?: boolean;
  /** The published site's SEO defaults (title template, default share image); the built-in ones when absent. */
  site?: PublicSiteSeo;
};

export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 630;
export const MIN_WORDS = 300;
export const MIN_INTERNAL_LINKS = 2;
const MIN_DESCRIPTION_CHARS = 70;
const MAX_SLUG_CHARS = 75;

// ---------------------------------------------------------------------------------------------
// What the page shows in search and on social (derived from buildHead, so it matches the head)

export type EffectiveSeo = {
  path: string;
  url: string;
  /** The `<title>` (site template applied unless the title is exact). */
  title: string;
  description: string;
  shareTitle: string;
  shareDescription: string;
  /** `src` is site-relative (`/media/<id>` or the site default), for previews on any origin. */
  image: { src: string; alt: string; mediaId?: string; isDefault: boolean };
  index: boolean;
};

export function effectiveSeo(
  doc: PageDoc,
  config: SiteConfig,
  site: PublicSiteSeo = defaultSeo(config)
): EffectiveSeo {
  const path = slugToPath(doc.seo.slug);
  const { meta, links } = buildHead(doc, path, config, site);
  const named = (key: string) =>
    meta.find(
      (m) =>
        ("name" in m && m.name === key) ||
        ("property" in m && m.property === key)
    );
  const content = (key: string) => {
    const m = named(key);
    return m && "content" in m ? m.content : "";
  };
  const titleTag = meta.find((m) => "title" in m);
  const image = shareImageOf(doc);
  const fallback = site.defaultShareImage;
  return {
    path,
    url:
      links.find((l) => l.rel === "canonical")?.href ??
      `${config.origin}${path}`,
    title: titleTag && "title" in titleTag ? titleTag.title : doc.seo.title,
    description: content("description"),
    shareTitle: content("og:title"),
    shareDescription: content("og:description"),
    image: image
      ? {
          src: mediaUrl(image.mediaId),
          alt: image.alt,
          mediaId: image.mediaId,
          isDefault: false,
        }
      : {
          src: fallback.mediaId ? mediaUrl(fallback.mediaId) : fallback.url,
          alt: fallback.alt,
          mediaId: fallback.mediaId,
          isDefault: true,
        },
    index: doc.seo.robots.index,
  };
}

// ---------------------------------------------------------------------------------------------
// The page's outline, read from its blocks

/** `hiddenOn`: devices the heading is hidden on (its block's or its element's hide), when some are. */
export type OutlineHeading = {
  level: 1 | 2 | 3;
  text: string;
  blockKey: string;
  hiddenOn?: Device[];
};
export type OutlineLink = { href: string; internal: boolean; blockKey: string };
export type OutlineImage = { blockKey: string; label: string; alt: string };

export type PageOutline = {
  headings: OutlineHeading[];
  /** Visible text in page order (headings, paragraphs, labels). */
  texts: string[];
  /** The first paragraph-like text: a hero lead, an intro or the first rich-text paragraph. */
  firstParagraph: string;
  words: number;
  links: OutlineLink[];
  images: OutlineImage[];
};

/** Item titles each block renders as `<h3>`: [list prop, field]. Every block's own `heading` is an `<h2>` (the hero's is the `<h1>`). */
export const H3_ITEM_FIELDS: Readonly<
  Record<string, readonly [string, string]>
> = {
  featureGrid: ["items", "title"],
  faq: ["items", "q"],
  steps: ["items", "title"],
  pricing: ["plans", "name"],
  logos: ["items", "name"],
};

/** Top-level props rendered as headings other than `heading` (an `<h2>`, the hero's `<h1>`). */
const HEADING_PROPS: Readonly<
  Record<string, Readonly<Record<string, OutlineHeading["level"]>>>
> = {};

/** Props a block renders inside an element of another name; every other prop renders in the element of its own name, if the block has one. */
const PROP_ELEMENTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  hero: {
    primary: "buttons",
    secondary: "buttons",
    tertiary: "buttons",
    logoAlt: "logo",
  },
  cta: { primary: "buttons", secondary: "buttons" },
  testimonial: { items: "card" },
  image: { mediaId: "image", alt: "image" },
};

/**
 * Props the block's variant doesn't render: top-level names, or `list.field` for a field of every
 * list item. Kept in step with the components by the rendered-links and rendered-headings tests.
 */
function unrenderedProps(
  type: string,
  props: Record<string, unknown>
): ReadonlySet<string> {
  if (type === "hero" && props.variant !== "home") {
    return new Set(["tertiary", "logo", "logoAlt"]);
  }
  if (type === "featureGrid" && props.variant !== "services") {
    return new Set(["items.link"]);
  }
  // The category filter picks posts; it isn't shown.
  if (type === "postList") {
    return new Set(["category"]);
  }
  return new Set();
}

/** The item field rendered as `<h3>` for this block, if any: a checklist feature grid shows titles as plain lines. */
function h3ItemField(
  type: string,
  props: Record<string, unknown>
): readonly [string, string] | undefined {
  if (type === "featureGrid" && props.variant === "checklist") {
    return;
  }
  return H3_ITEM_FIELDS[type];
}

/** Props that hold no visible text (ids, links, enums, alt text) or repeat other text (`*Accent`). */
const NON_TEXT_KEYS = new Set([
  "_key",
  "href",
  "mediaId",
  "image",
  "bg",
  "variant",
  "icon",
  "alt",
  "logoAlt",
  "anchor",
  "kind",
]);
/** Props that hold a link (besides `href`). */
const LINK_KEYS = new Set(["href"]);
/** Props whose text is a paragraph (for "keyphrase in the first paragraph"). */
const PARAGRAPH_KEYS = new Set(["lead", "intro", "body", "subheading"]);

const hiddenEverywhere = (hidden: readonly Device[]) =>
  hidden.length === DEVICES.length;
const union = (a: readonly Device[], b: readonly Device[]) =>
  DEVICES.filter((d) => a.includes(d) || b.includes(d));

type RichNode = {
  type?: unknown;
  text?: unknown;
  attrs?: { level?: unknown };
  marks?: unknown;
  content?: unknown;
};

const isRichDoc = (v: unknown): v is RichNode =>
  typeof v === "object" && v !== null && (v as RichNode).type === "doc";

function richText(node: RichNode): string {
  if (typeof node.text === "string") {
    return node.text;
  }
  return Array.isArray(node.content)
    ? (node.content as RichNode[]).map(richText).join("")
    : "";
}

/**
 * Headings, text, links and images as visitors get them, in page order: only blocks that validate
 * (the renderer skips the rest), nothing hidden on every device (a block, or one of its elements),
 * and only what the block's variant renders.
 */
export function pageOutline(
  doc: PageDoc,
  config: Pick<SiteConfig, "origin">
): PageOutline {
  const out: PageOutline = {
    headings: [],
    texts: [],
    firstParagraph: "",
    words: 0,
    links: [],
    images: [],
  };
  const pushText = (text: string, paragraph: boolean) => {
    const t = text.trim();
    if (!t) {
      return;
    }
    out.texts.push(t);
    if (paragraph && !out.firstParagraph) {
      out.firstParagraph = t;
    }
  };
  const pushLink = (href: string, blockKey: string) =>
    out.links.push({ href, internal: isInternalHref(href, config), blockKey });

  // A post's H1 is its title, which the post layout renders above the body (no block holds it).
  if (doc.post && doc.seo.title.trim()) {
    out.headings.push({ level: 1, text: doc.seo.title.trim(), blockKey: "" });
    pushText(doc.seo.title, false);
  }

  for (const raw of doc.blocks) {
    const { def, block } = parseBlock(raw);
    if (!(def && block)) {
      continue;
    }
    const style = mergeStyle(def.defaultStyle, block.style);
    const blockHidden = hiddenOn(style.hide);
    if (hiddenEverywhere(blockHidden)) {
      continue;
    }
    const props = (block.props ?? {}) as Record<string, unknown>;
    const key = block._key;
    const itemField = h3ItemField(block._type, props);
    const unrendered = unrenderedProps(block._type, props);
    /** Devices `prop`'s element is hidden on (with the block's); `[]` when it has no element. */
    const elementHidden = (prop: string, topLevel: boolean): Device[] => {
      const name =
        (topLevel ? PROP_ELEMENTS[block._type]?.[prop] : undefined) ??
        (Object.hasOwn(def.elements, prop) ? prop : undefined);
      return union(
        blockHidden,
        name ? hiddenOn(style.elements?.[name]?.hide) : []
      );
    };
    const heading = (
      level: OutlineHeading["level"],
      text: string,
      hidden: readonly Device[]
    ): OutlineHeading => ({
      level,
      text,
      blockKey: key,
      ...(hidden.length > 0 && { hiddenOn: [...hidden] }),
    });

    const walkRich = (node: RichNode, hidden: Device[]) => {
      if (node.type === "heading") {
        const level = node.attrs?.level === 3 ? 3 : 2;
        const text = richText(node).trim();
        if (text) {
          out.headings.push(heading(level, text, hidden));
        }
        pushText(text, false);
        return;
      }
      if (node.type === "paragraph") {
        for (const t of (Array.isArray(node.content)
          ? node.content
          : []) as RichNode[]) {
          for (const mark of (Array.isArray(t.marks) ? t.marks : []) as {
            type?: unknown;
            attrs?: { href?: unknown };
          }[]) {
            if (mark.type === "link" && typeof mark.attrs?.href === "string") {
              pushLink(mark.attrs.href, key);
            }
          }
        }
        pushText(richText(node), true);
        return;
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content as RichNode[]) {
          walkRich(child, hidden);
        }
      }
    };

    /** `list`: the top-level list prop the value is an item (or inside an item) of. */
    const walk = (
      value: unknown,
      prop: string,
      hidden: Device[],
      list: string | null
    ) => {
      if (typeof value === "string") {
        if (LINK_KEYS.has(prop)) {
          return pushLink(value, key);
        }
        if (NON_TEXT_KEYS.has(prop) || prop.endsWith("Accent")) {
          return;
        }
        if (
          list &&
          itemField &&
          list === itemField[0] &&
          prop === itemField[1]
        ) {
          out.headings.push(heading(3, value.trim(), hidden));
        }
        return pushText(value, PARAGRAPH_KEYS.has(prop));
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, prop, hidden, list ?? prop);
        }
        return;
      }
      if (isRichDoc(value)) {
        return walkRich(value, hidden);
      }
      if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          if (list && unrendered.has(`${list}.${k}`)) {
            continue;
          }
          const inner = union(hidden, elementHidden(k, false));
          if (!hiddenEverywhere(inner)) {
            walk(v, k, inner, list);
          }
        }
      }
    };

    for (const [prop, value] of Object.entries(props)) {
      if (unrendered.has(prop)) {
        continue;
      }
      const hidden = elementHidden(prop, true);
      if (hiddenEverywhere(hidden)) {
        continue;
      }
      if (prop === "heading" && typeof value === "string") {
        const text = value.trim();
        if (text) {
          out.headings.push(
            heading(block._type === "hero" ? 1 : 2, text, hidden)
          );
        }
        pushText(text, false);
        continue;
      }
      const level = HEADING_PROPS[block._type]?.[prop];
      if (level && typeof value === "string") {
        const text = value.trim();
        if (text) {
          out.headings.push(heading(level, text, hidden));
        }
        pushText(text, false);
        continue;
      }
      walk(value, prop, hidden, null);
    }

    // Images and their alt text (testimonial avatars are decorative by design: alt="").
    if (
      block._type === "image" &&
      typeof props.mediaId === "string" &&
      !hiddenEverywhere(elementHidden("mediaId", true))
    ) {
      out.images.push({
        blockKey: key,
        label: def.label,
        alt: typeof props.alt === "string" ? props.alt : "",
      });
    }
    // The hero's logo is `{ mediaId, alt }`.
    const logo = props.logo as { mediaId?: unknown; alt?: unknown } | undefined;
    if (
      block._type === "hero" &&
      typeof logo?.mediaId === "string" &&
      !unrendered.has("logo") &&
      !hiddenEverywhere(elementHidden("logo", true))
    ) {
      out.images.push({
        blockKey: key,
        label: "Hero logo",
        alt: typeof logo.alt === "string" ? logo.alt : "",
      });
    }
  }
  out.words = out.texts.reduce((n, t) => n + countWords(t), 0);
  return out;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A site-relative path ("/x", not "//host") or an absolute URL on this site. */
export function isInternalHref(
  href: string,
  config: Pick<SiteConfig, "origin">
): boolean {
  const { origin } = config;
  if (href.startsWith("/")) {
    return !href.startsWith("//");
  }
  return (
    href === origin ||
    href.startsWith(`${origin}/`) ||
    href.startsWith(`${origin}#`) ||
    href.startsWith(`${origin}?`)
  );
}

/** "/services/x?a#b" or "https://site/services/x" → "/services/x" (no trailing slash; home is "/"). */
function hrefPath(
  href: string,
  { origin }: Pick<SiteConfig, "origin">
): string {
  const rel = href.startsWith(origin) ? href.slice(origin.length) || "/" : href;
  const path = (rel.split(/[?#]/)[0] ?? "").replace(/\/+$/, "");
  return path || "/";
}

// ---------------------------------------------------------------------------------------------
// Checks

/** Lower-case words without punctuation or accents, joined by single spaces. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A word without a plural ending: "strategies" → "strategy", "boxes" → "box", "teams" → "team" ("ss" stays). */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 3 && /(?:s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

const stemmed = (text: string) =>
  normalizeText(text).split(" ").filter(Boolean).map(singular).join(" ");

/** Whether `phrase` appears in `text` as whole words, singular or plural ("AI strategy" matches "AI strategies"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const p = stemmed(phrase);
  return p !== "" && ` ${stemmed(text)} `.includes(` ${p} `);
}

/** Same text for people: case, accents, whitespace and punctuation don't count ("A – B" = "a b"). */
const sameText = (a: string, b: string) =>
  normalizeText(a) === normalizeText(b);

const check = (
  id: string,
  label: string,
  status: CheckStatus,
  message: string
): SeoCheck => ({ id, label, status, message });

export function runSeoChecks(doc: PageDoc, ctx: SeoContext): SeoCheck[] {
  const { config } = ctx;
  const measure = ctx.measure ?? arialMeasure;
  const eff = effectiveSeo(doc, config, ctx.site);
  const outline = pageOutline(doc, config);
  const others = (ctx.others ?? []).filter((o) => o.id !== ctx.pageId);
  const { seo } = doc;
  const results: SeoCheck[] = [];

  // Title
  const titleWidth = Math.round(measure(eff.title, TITLE_FONT_PX));
  if (!seo.title.trim()) {
    results.push(
      check("title-length", "Title length", "fail", "The page has no title.")
    );
  } else if (repeatsSiteName(seo, eff.title)) {
    results.push(
      check(
        "title-length",
        "Title length",
        "warn",
        "The title already has the site name, so it shows twice; remove it or turn on “Exact title”."
      )
    );
  } else if (titleWidth > TITLE_MAX_PX) {
    results.push(
      check(
        "title-length",
        "Title length",
        "warn",
        `The title is ${titleWidth}px wide; Google cuts it at about ${TITLE_MAX_PX}px.`
      )
    );
  } else {
    results.push(
      check(
        "title-length",
        "Title length",
        "pass",
        `${titleWidth}px of about ${TITLE_MAX_PX}px.`
      )
    );
  }

  // Static pages' titles count too: a CMS page can't take their URL, but it can repeat their title.
  const staticPages = Object.entries(staticPageTitles(config)).map(
    ([slug, title]) => ({ id: `static:${slug}`, slug, title, description: "" })
  );
  const sameTitle = [...others, ...staticPages].filter((o) =>
    sameText(o.title, eff.title)
  );
  results.push(
    ctx.others === undefined
      ? check(
          "title-unique",
          "Unique title",
          "na",
          "Other pages weren't loaded."
        )
      : sameTitle.length
        ? check(
            "title-unique",
            "Unique title",
            "fail",
            `Same title as ${listPaths(sameTitle)}.`
          )
        : check(
            "title-unique",
            "Unique title",
            "pass",
            "No other page has this title."
          )
  );

  // Description (a post without one uses its excerpt, build-head.ts pageDescription)
  const description = pageDescription(doc).trim();
  const descWidth = Math.round(measure(description, DESCRIPTION_FONT_PX));
  if (!description) {
    results.push(
      check(
        "description-length",
        "Meta description",
        "warn",
        "No description: Google will pick text from the page."
      )
    );
  } else if (description.length < MIN_DESCRIPTION_CHARS) {
    results.push(
      check(
        "description-length",
        "Meta description",
        "warn",
        `Only ${description.length} characters; aim for ${MIN_DESCRIPTION_CHARS}–160.`
      )
    );
  } else if (descWidth > DESCRIPTION_MAX_PX) {
    results.push(
      check(
        "description-length",
        "Meta description",
        "warn",
        `${descWidth}px wide; Google cuts it at about ${DESCRIPTION_MAX_PX}px.`
      )
    );
  } else {
    results.push(
      check(
        "description-length",
        "Meta description",
        "pass",
        `${descWidth}px of about ${DESCRIPTION_MAX_PX}px.`
      )
    );
  }

  const sameDesc = description
    ? others.filter((o) => sameText(o.description, description))
    : [];
  results.push(
    ctx.others === undefined || !description
      ? check(
          "description-unique",
          "Unique description",
          "na",
          description
            ? "Other pages weren't loaded."
            : "No description to compare."
        )
      : sameDesc.length
        ? check(
            "description-unique",
            "Unique description",
            "warn",
            `Same description as ${listPaths(sameDesc)}.`
          )
        : check(
            "description-unique",
            "Unique description",
            "pass",
            "No other page has this description."
          )
  );

  // Headings
  const h1s = outline.headings.filter((h) => h.level === 1);
  results.push(
    h1s.length === 1
      ? h1s[0]!.hiddenOn?.includes("mobile")
        ? check(
            "h1",
            "One H1",
            "warn",
            `“${h1s[0]!.text}” is hidden on mobile; Google reads the mobile page, so it finds no H1.`
          )
        : check("h1", "One H1", "pass", `“${h1s[0]!.text}”`)
      : h1s.length === 0
        ? check(
            "h1",
            "One H1",
            "fail",
            "No H1: add a hero block (its heading is the page's H1)."
          )
        : check(
            "h1",
            "One H1",
            "fail",
            `${h1s.length} H1s: keep one hero per page.`
          )
  );
  results.push(headingOrderCheck(outline.headings));

  // Keyphrase
  results.push(...keyphraseChecks(doc, outline));

  // Images
  const noAlt = outline.images.filter((img) => !img.alt.trim());
  results.push(
    outline.images.length
      ? noAlt.length
        ? check(
            "image-alt",
            "Image alt text",
            "fail",
            `${noAlt.length} of ${outline.images.length} images have no alt text (${[...new Set(noAlt.map((i) => i.label))].join(", ")}).`
          )
        : check(
            "image-alt",
            "Image alt text",
            "pass",
            `All ${outline.images.length} images have alt text.`
          )
      : check("image-alt", "Image alt text", "na", "No images on the page.")
  );

  // Internal links: distinct pages linked from this one (links back to itself don't count)
  const internal = new Set(
    outline.links
      .filter((l) => l.internal && !l.href.startsWith("#"))
      .map((l) => hrefPath(l.href, config))
      .filter((p) => p !== eff.path)
  ).size;
  results.push(
    internal >= MIN_INTERNAL_LINKS
      ? check(
          "internal-links",
          "Internal links",
          "pass",
          `Links to ${internal} other pages on the site.`
        )
      : check(
          "internal-links",
          "Internal links",
          "warn",
          `Links to ${internal} other page${internal === 1 ? "" : "s"} on the site; link to at least ${MIN_INTERNAL_LINKS} related pages.`
        )
  );

  // Word count
  results.push(
    outline.words >= MIN_WORDS
      ? check("word-count", "Word count", "pass", `${outline.words} words.`)
      : check(
          "word-count",
          "Word count",
          "warn",
          `${outline.words} words; pages under ${MIN_WORDS} rarely rank.`
        )
  );

  // Slug
  results.push(slugCheck(seo.slug, ctx));

  // Share image
  results.push(shareImageCheck(doc, ctx));

  // Indexing and sitemap (noindex is a choice, not a problem: reported, not scored)
  results.push(
    seo.robots.index
      ? seo.sitemap.include
        ? check(
            "indexing",
            "Indexing and sitemap",
            "pass",
            "Indexable and in the sitemap."
          )
        : check(
            "indexing",
            "Indexing and sitemap",
            "warn",
            "Indexable but left out of the sitemap."
          )
      : check(
          "indexing",
          "Indexing and sitemap",
          "info",
          `noindex: search engines won't list this page${seo.sitemap.include ? "; it's left out of the sitemap while it's noindex" : ", and it's left out of the sitemap"}.`
        )
  );

  // Structured data
  results.push(jsonLdCheck(doc, eff.path, config));

  // Colour contrast
  results.push(contrastCheck(doc));

  return results;
}

/**
 * Whether the title template adds words the title already has ("Pricing | Example Co"
 * typed into a template that appends " | Example Co").
 */
function repeatsSiteName(seo: PageDoc["seo"], fullTitle: string): boolean {
  const title = seo.title.trim();
  if (seo.titleExact || !title) {
    return false;
  }
  const at = fullTitle.indexOf(title);
  if (at < 0) {
    return false;
  }
  const added = normalizeText(
    `${fullTitle.slice(0, at)} ${fullTitle.slice(at + title.length)}`
  );
  return added !== "" && ` ${normalizeText(title)} `.includes(` ${added} `);
}

function listPaths(pages: SeoOtherPage[]): string {
  const paths = pages.map((p) => slugToPath(p.slug));
  return paths.length > 3
    ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`
    : paths.join(", ");
}

function headingOrderCheck(headings: OutlineHeading[]): SeoCheck {
  const label = "Heading order";
  if (!headings.length) {
    return check("heading-order", label, "na", "No headings.");
  }
  if (headings[0]!.level !== 1 && headings.some((h) => h.level === 1)) {
    return check(
      "heading-order",
      label,
      "warn",
      `“${headings[0]!.text}” comes before the H1; put the hero first.`
    );
  }
  let prev = headings[0]!.level;
  for (const h of headings.slice(1)) {
    if (h.level === 1) {
      return check(
        "heading-order",
        label,
        "warn",
        `A second H1 (“${h.text}”) appears later in the page.`
      );
    }
    if (h.level > prev + 1) {
      return check(
        "heading-order",
        label,
        "warn",
        `H${h.level} “${h.text}” follows an H${prev}; don't skip a level.`
      );
    }
    prev = h.level;
  }
  return check(
    "heading-order",
    label,
    "pass",
    "Headings step down one level at a time."
  );
}

function keyphraseChecks(doc: PageDoc, outline: PageOutline): SeoCheck[] {
  const phrase = doc.seo.focusKeyphrase?.trim() ?? "";
  if (!phrase) {
    return [
      check(
        "keyphrase",
        "Focus keyphrase",
        "warn",
        "No focus keyphrase: set the search phrase this page should rank for."
      ),
    ];
  }
  const h1 = outline.headings.find((h) => h.level === 1)?.text ?? "";
  const slugWords = doc.seo.slug.replace(/[/-]+/g, " ");
  const place = (id: string, label: string, ok: boolean, where: string) =>
    check(
      id,
      label,
      ok ? "pass" : "warn",
      ok
        ? `“${phrase}” is in the ${where}.`
        : `“${phrase}” isn't in the ${where}.`
    );
  return [
    check("keyphrase", "Focus keyphrase", "pass", `“${phrase}”`),
    // The page's own title: the site name the template adds doesn't count.
    place(
      "keyphrase-title",
      "Keyphrase in title",
      containsPhrase(doc.seo.title, phrase),
      "title"
    ),
    place("keyphrase-h1", "Keyphrase in H1", containsPhrase(h1, phrase), "H1"),
    place(
      "keyphrase-intro",
      "Keyphrase in first paragraph",
      containsPhrase(outline.firstParagraph, phrase),
      "first paragraph"
    ),
    doc.seo.slug === ""
      ? check(
          "keyphrase-slug",
          "Keyphrase in URL",
          "na",
          "The home page has no slug."
        )
      : place(
          "keyphrase-slug",
          "Keyphrase in URL",
          containsPhrase(slugWords, phrase),
          "URL"
        ),
  ];
}

/** The format and publish rules for the slug (pages-service.ts `checkKind`, `checkReserved`), then length and depth. */
function slugCheck(slug: string, ctx: SeoContext): SeoCheck {
  const label = "URL";
  if (slug === "") {
    return ctx.isHome === false
      ? check(
          "slug",
          label,
          "fail",
          "/ is the home page's URL; give this page its own slug."
        )
      : check("slug", label, "pass", "The home page.");
  }
  if (!isValidSlug(slug)) {
    return check(
      "slug",
      label,
      "fail",
      "Use lowercase words separated by - and /."
    );
  }
  const inBlog = slug.startsWith("blog/");
  if (ctx.kind === "post" && !inBlog) {
    return check("slug", label, "fail", "A post's URL starts with /blog/.");
  }
  if (ctx.kind !== "post" && inBlog) {
    return check("slug", label, "fail", "URLs under /blog/ are for posts.");
  }
  if (ctx.kind !== "post" && isReservedSlug(slug)) {
    return check(
      "slug",
      label,
      "fail",
      `${slugToPath(slug)} belongs to a page built into the site; publishing will refuse it.`
    );
  }
  if (slug.length > MAX_SLUG_CHARS) {
    return check(
      "slug",
      label,
      "warn",
      `${slug.length} characters; keep URLs under ${MAX_SLUG_CHARS}.`
    );
  }
  if (slug.split("/").length > 3) {
    return check(
      "slug",
      label,
      "warn",
      "More than 3 levels deep; keep URLs shallow."
    );
  }
  return check("slug", label, "pass", slugToPath(slug));
}

function shareImageCheck(doc: PageDoc, ctx: SeoContext): SeoCheck {
  const label = "Share image";
  // A post without its own share image uses its featured image (build-head.ts shareImageOf).
  const image = shareImageOf(doc);
  if (!image) {
    return check(
      "share-image",
      label,
      "warn",
      "No share image: social posts show the site default."
    );
  }
  if (!image.alt.trim()) {
    return check(
      "share-image",
      label,
      "warn",
      "The share image has no alt text."
    );
  }
  if (!ctx.media) {
    return check("share-image", label, "na", "The image's size wasn't loaded.");
  }
  const size = ctx.media[image.mediaId];
  if (!size) {
    return check(
      "share-image",
      label,
      "fail",
      "The share image isn't in the media library any more; pick another."
    );
  }
  if (size.width === SHARE_IMAGE_WIDTH && size.height === SHARE_IMAGE_HEIGHT) {
    return check(
      "share-image",
      label,
      "pass",
      `${SHARE_IMAGE_WIDTH}×${SHARE_IMAGE_HEIGHT}.`
    );
  }
  return check(
    "share-image",
    label,
    "warn",
    `${size.width ?? "?"}×${size.height ?? "?"}: use ${SHARE_IMAGE_WIDTH}×${SHARE_IMAGE_HEIGHT} (Create share image…), or platforms crop it.`
  );
}

const hasType = (node: Record<string, unknown>) => {
  const t = node["@type"];
  return (
    (typeof t === "string" && t.trim() !== "") ||
    (Array.isArray(t) &&
      t.length > 0 &&
      t.every((x) => typeof x === "string" && x))
  );
};

function jsonLdCheck(doc: PageDoc, path: string, config: SiteConfig): SeoCheck {
  const label = "Structured data";
  let nodes: Record<string, unknown>[];
  try {
    nodes = buildJsonLd(doc, path, config);
  } catch (err) {
    return check(
      "json-ld",
      label,
      "fail",
      `The JSON-LD couldn't be built: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const untyped = nodes.filter((n) => !hasType(n));
  if (untyped.length) {
    return check(
      "json-ld",
      label,
      "fail",
      `${untyped.length} node${untyped.length === 1 ? " has" : "s have"} no @type.`
    );
  }
  const types = nodes.map((n) => String(n["@type"]));
  const faqBlocks = doc.blocks.filter(
    (b) =>
      b._type === "faq" &&
      Array.isArray((b.props as { items?: unknown })?.items) &&
      (b.props as { items: unknown[] }).items.length > 0
  );
  const faqPages = types.filter((t) => t === "FAQPage").length;
  if (faqBlocks.length && !faqPages) {
    return check(
      "json-ld",
      label,
      "warn",
      "The FAQ block's questions are hidden, so there's no FAQPage."
    );
  }
  if (faqPages > 1) {
    return check(
      "json-ld",
      label,
      "warn",
      `${faqPages} FAQPage nodes; Google expects one per page.`
    );
  }
  return check(
    "json-ld",
    label,
    "pass",
    `${nodes.length} node${nodes.length === 1 ? "" : "s"}: ${[...new Set(types)].join(", ")}.`
  );
}

function contrastCheck(doc: PageDoc): SeoCheck {
  const label = "Colour contrast";
  let rated = 0;
  const failing: string[] = [];
  for (const block of doc.blocks as Block[]) {
    const def = getBlockDef(block._type);
    if (!def) {
      continue;
    }
    const merged = mergeStyle(def.defaultStyle, block.style);
    if (hiddenEverywhere(hiddenOn(merged.hide))) {
      continue;
    }
    const onCard = (def.onCard?.length ?? 0) > 0;
    const pairs: { name: string; rating: ReturnType<typeof rateContrast> }[] =
      [];
    for (const name of ["text", "heading", "accent"] as const) {
      const color = merged.colors?.[name];
      if (color) {
        pairs.push({
          name,
          rating: rateContrast(color, merged, false, onCard),
        });
      }
    }
    for (const [name, el] of Object.entries(merged.elements ?? {})) {
      if (el.color) {
        pairs.push({
          name,
          rating: rateContrast(
            el.color,
            merged,
            isLargeSize(el.size?.desktop),
            def.onCard?.includes(name)
          ),
        });
      }
    }
    for (const { name, rating } of pairs) {
      if (rating.kind !== "rated") {
        continue;
      }
      rated++;
      if (!rating.pass) {
        failing.push(`${def.label} ${name} ${rating.ratio.toFixed(1)}:1`);
      }
    }
  }
  if (!rated) {
    return check(
      "contrast",
      label,
      "na",
      "No custom colours on a solid background to rate."
    );
  }
  if (failing.length) {
    return check(
      "contrast",
      label,
      "warn",
      `Below WCAG AA: ${failing.join("; ")}.`
    );
  }
  return check(
    "contrast",
    label,
    "pass",
    `${rated} rated colour pair${rated === 1 ? "" : "s"} meet WCAG AA.`
  );
}

// ---------------------------------------------------------------------------------------------
// Summaries

/** 0–100: pass 1, warn ½, fail 0; "na" and "info" checks don't count. */
export function seoScore(checks: SeoCheck[]): number {
  const counted = checks.filter(
    (c) => c.status !== "na" && c.status !== "info"
  );
  if (!counted.length) {
    return 100;
  }
  const points = counted.reduce(
    (n, c) => n + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0),
    0
  );
  return Math.round((points / counted.length) * 100);
}

/**
 * The checklist's warnings and failures, for the publish dialog. Warn-only: publishing goes ahead
 * whatever this returns; "fail" is just the more serious level.
 */
export function seoWarnings(
  doc: PageDoc,
  ctx: SeoContext
): { level: "warn" | "fail"; message: string }[] {
  return runSeoChecks(doc, ctx).flatMap((c) =>
    c.status === "warn" || c.status === "fail"
      ? [{ level: c.status, message: `${c.label}: ${c.message}` }]
      : []
  );
}
