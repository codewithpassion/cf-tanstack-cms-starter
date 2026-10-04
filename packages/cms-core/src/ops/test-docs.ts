import type { Block, PageDoc, PageSeo, PostMeta } from "../types";

/** Minimal documents for the ops and page-service unit tests (no block registry needed). */

export function seo(overrides: Partial<PageSeo> = {}): PageSeo {
  return {
    title: "Home",
    description: "AI transformation consulting",
    slug: "home",
    robots: { index: true, follow: true },
    sitemap: { include: true },
    social: {},
    schema: { pageType: "WebPage" },
    llms: { include: true },
    ...overrides,
  };
}

export function block(
  key: string,
  type: string,
  props: Record<string, unknown> = {},
  extra: Partial<Block> = {}
): Block {
  return { _key: key, _type: type, _v: 1, props, ...extra };
}

export function doc(
  blocks: Block[] = defaultBlocks(),
  extra: Partial<PageDoc> = {}
): PageDoc {
  return { _schema: 1, seo: seo(), blocks, ...extra };
}

export function post(overrides: Partial<PostMeta> = {}): PostMeta {
  return {
    excerpt: "An excerpt",
    author: "Jane",
    publishedAt: "2026-09-01",
    category: "AI",
    tags: ["ai"],
    readingTime: 3,
    ...overrides,
  };
}

export function defaultBlocks(): Block[] {
  return [
    block(
      "hero",
      "hero",
      { heading: "Hello", sub: { text: "Sub", em: true }, links: ["a", "b"] },
      {
        style: { padding: { desktop: { top: 96 }, mobile: { top: 48 } } },
      }
    ),
    block("faq", "faq", { items: [{ q: "Q1", a: "A1" }] }),
    block("cta", "cta", { label: "Book" }),
  ];
}

/** Freezes a value recursively, so any mutation in strict-mode code throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

/** `items[index]`, throwing when it's missing (tests index into fixed fixtures; noUncheckedIndexedAccess). */
export function nth<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) {
    throw new Error(`No item at index ${index}`);
  }
  return item;
}
