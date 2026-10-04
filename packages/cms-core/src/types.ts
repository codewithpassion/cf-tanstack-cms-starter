/**
 * Core CMS document types.
 * Shared by the renderer, the editor, the ops engine, the server and the agent.
 * Pure types only: no runtime imports, safe for client and server bundles.
 */

export type Device = "desktop" | "tablet" | "mobile";

/** Desktop is the base; tablet and mobile override it. Unset = inherit the next larger device; the block default applies only to a property unset on every device. */
export type Responsive<T> = Partial<Record<Device, T>>;

/** Brand tokens map to `--color-<token>` in src/styles.css `@theme static` (the design knob: rename values here and in the theme together). */
export const BRAND_TOKENS = [
  "primary",
  "primary-soft",
  "accent",
  "danger",
  "ink",
  "ink-soft",
  "muted",
  "white",
] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];

export type Color = { token: BrandToken } | { hex: string };

export type GradientPreset =
  | "none"
  | "dark"
  | "ink-rise"
  | "primary-glow"
  | "accent-glow"
  | "accent-edge"
  | "accent-primary";

export type Visibility = Partial<Record<Device, boolean>>;

export type Align = "left" | "center" | "right";
export type MaxWidth = "narrow" | "default" | "wide" | "full";
export type TextSize = "sm" | "base" | "lg" | "xl" | "2xl";

export type ElementStyle = {
  color?: Color;
  size?: Responsive<TextSize>;
  align?: Responsive<Align>;
  hide?: Visibility;
};

export type BlockStyle = {
  hide?: Visibility;
  padding?: Responsive<{ top?: number; bottom?: number; x?: number }>;
  margin?: Responsive<{ top?: number; bottom?: number }>;
  gap?: Responsive<number>;
  maxWidth?: Responsive<MaxWidth>;
  align?: Responsive<Align>;
  background?: {
    color?: Color;
    gradient?: GradientPreset;
    image?: { mediaId: string; overlay?: Color; opacity?: number };
  };
  colors?: { text?: Color; heading?: Color; accent?: Color };
  border?: "none" | "cyber" | "subtle";
  /** Named elements a block declares as styleable, e.g. "heading", "body", "button", "items" (all items as a group). */
  elements?: Record<string, ElementStyle>;
};

export type BlockKey = string;

export type Block = {
  _key: BlockKey;
  _type: string;
  _v: number;
  /** Validated by the block type's Zod schema. */
  props: unknown;
  style?: BlockStyle;
};

export type JsonLd = Record<string, unknown>;

export type PageSchemaType =
  | "WebPage"
  | "Service"
  | "LocalBusiness"
  | "AboutPage"
  | "ContactPage"
  | "CollectionPage"
  | "Article";

export type PageSeo = {
  title: string;
  titleExact?: boolean;
  description: string;
  slug: string;
  canonical?: string;
  robots: { index: boolean; follow: boolean };
  sitemap: { include: boolean };
  focusKeyphrase?: string;
  social: {
    title?: string;
    description?: string;
    /** `width`/`height`: the media's pixel size, stored when picked (og:image:width/height). */
    image?: { mediaId: string; alt: string; width?: number; height?: number };
  };
  schema: {
    pageType: PageSchemaType;
    breadcrumbLabel?: string;
    extra?: JsonLd[];
  };
  llms: { include: boolean; summary?: string };
};

export type PostMeta = {
  /** The post's title (H1, Article headline, /blog and post cards, llms.txt); `seo.title` when unset. */
  title?: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  /** "Updated" date for Article `dateModified`; `publishedAt` when unset. */
  modifiedAt?: string;
  category: string;
  tags: string[];
  featuredImage?: { mediaId: string; alt: string };
  /** Minutes, computed from the body on every save (app/cms/posts.ts). */
  readingTime: number;
  /** Minutes shown instead of the computed `readingTime`, when set. */
  readingTimeOverride?: number;
  /**
   * Set only on a post created in the editor ("New post"), whose `publishedAt` is its creation
   * day: the first publish re-dates it to the publish day and drops the flag (editor/store.ts).
   * Editing the date drops it too. Absent everywhere else (migrated posts keep their dates).
   */
  publishedAtAuto?: true;
};

export type PageKind = "page" | "post";

/**
 * `none`: the page renders without the site navigation and footer (render/cms-page.tsx), for a
 * standalone page that brings its own. Unset = `site`.
 * Set by imports; the editor keeps it but has no control for it yet.
 */
export type PageChrome = "site" | "none";

export type PageDoc = {
  _schema: 1;
  seo: PageSeo;
  post?: PostMeta;
  chrome?: PageChrome;
  blocks: Block[];
};

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** JSON merge-patch of T (RFC 7396): `null` deletes a key, arrays replace wholesale. */
export type MergePatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: MergePatch<T[K]> | null }
    : T;

export type InsertAt = { after?: BlockKey; before?: BlockKey; index?: number };

/** A block as supplied to insert/replace; `_key` is generated when absent. */
export type NewBlock = Omit<Block, "_key" | "_v"> & {
  _key?: BlockKey;
  _v?: number;
};

export type Op =
  | { op: "insert"; at: InsertAt; block: NewBlock }
  | {
      op: "update";
      key: BlockKey;
      props?: Record<string, unknown>;
      style?: MergePatch<BlockStyle>;
    }
  | { op: "replace"; key: BlockKey; block: NewBlock }
  | { op: "move"; key: BlockKey; to: InsertAt }
  | { op: "remove"; key: BlockKey }
  | { op: "setSeo"; seo: MergePatch<PageSeo> }
  | { op: "setPost"; post: MergePatch<PostMeta> };

/** Result of validating a document against the block registry (owned by app/cms/validate.ts). */
export type ValidationResult =
  | { ok: true; doc: PageDoc }
  | { ok: false; errors: { path: string; message: string }[] };
