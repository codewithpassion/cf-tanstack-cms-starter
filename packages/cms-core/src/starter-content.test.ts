import { describe, expect, it } from "bun:test";

import { BLOCK_TYPES } from "./blocks/registry";
import { validateSiteDoc } from "./site/schema";
import {
  STARTER_IMAGE_KEYS,
  type StarterMedia,
  starterPages,
  starterSiteDoc,
} from "./starter-content";
import { TEST_CONFIG } from "./test-fixtures";
import { validatePageDoc } from "./validate";

const media = Object.fromEntries(
  STARTER_IMAGE_KEYS.map((key, i) => [
    key,
    { mediaId: `${String(i).repeat(64)}.png`, width: 1200, height: 630 },
  ])
) as StarterMedia;

describe("starter content", () => {
  const pages = starterPages(media);

  it("builds home, about, pricing, contact and three posts", () => {
    expect(pages.map((p) => p.slug)).toEqual([
      "",
      "about",
      "pricing",
      "contact",
      "blog/welcome-to-the-blog",
      "blog/how-we-work",
      "blog/what-is-next",
    ]);
    expect(pages.filter((p) => p.kind === "post")).toHaveLength(3);
  });

  it.each(pages.map((p) => [p.slug || "(home)", p] as const))(
    "%s validates as a page doc",
    (_slug, page) => {
      const result = validatePageDoc(page.doc);
      expect(result.ok).toBe(true);
      expect(page.doc.seo.slug).toBe(page.slug);
    }
  );

  it("uses every block type somewhere", () => {
    const used = new Set(
      pages.flatMap((p) => p.doc.blocks.map((b) => b._type))
    );
    for (const type of BLOCK_TYPES) {
      expect(used.has(type)).toBe(true);
    }
  });

  it("builds a valid site doc with the five nav links and a CTA", () => {
    const doc = starterSiteDoc(TEST_CONFIG);
    expect(validateSiteDoc(doc).ok).toBe(true);
    expect(doc.nav.links.map((l) => l.label)).toEqual([
      "Home",
      "About",
      "Pricing",
      "Blog",
      "Contact",
    ]);
    expect(doc.nav.cta.href).toBe("/contact");
  });
});
