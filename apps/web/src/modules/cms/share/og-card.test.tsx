// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; test-only regexes.

import { describe, expect, it } from "bun:test";
import { createBlock } from "@repo/cms-core/blocks/registry";
import { sampleSeo, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import type { Block, PageDoc } from "@repo/cms-core/types";
import { renderToString } from "react-dom/server";

import { SiteConfigProvider } from "../site/site-context";
import { OgCard } from "./og-card";

const docOf = (...blocks: Block[]): PageDoc => ({
  _schema: 1,
  seo: { ...sampleSeo(), title: "SEO title" },
  blocks,
});
const hero = (props: Record<string, unknown>) =>
  createBlock("hero", { _key: "hero1", props } as Parameters<
    typeof createBlock
  >[1] & { _key: string });
const render = (doc: PageDoc, template: "hero" | "card" = "hero") =>
  renderToString(
    <SiteConfigProvider value={TEST_CONFIG}>
      <OgCard doc={doc} kind="page" params={{ template }} />
    </SiteConfigProvider>
  );

describe("OgCard hero template", () => {
  it("renders the hero as on the public site: no edit markup, no hidden entrance state", () => {
    const html = render(
      docOf(
        hero({
          variant: "page",
          eyebrow: "CMS test",
          heading: "Built with blocks",
        })
      )
    );
    expect(html).toContain("Built with blocks");
    expect(html).not.toContain("data-cms-field");
    expect(html).not.toContain("data-cms-key");
    // Reveal starts at opacity 0 unless its initial state is skipped.
    expect(html).not.toMatch(/opacity:\s*0/);
  });

  it("falls back to the card template when the hero doesn't validate", () => {
    // `heading` is required.
    const html = render(
      docOf(hero({ variant: "page", eyebrow: "CMS test", heading: "" }))
    );
    expect(html).not.toContain("Can&#x27;t render block");
    expect(html).not.toContain("Can't render block");
    expect(html).toMatch(/<h1[^>]*>SEO title<\/h1>/);
  });
});

describe("OgCard wordmark and gradients", () => {
  it("prints the SiteConfig name as the wordmark", () => {
    expect(render(docOf(), "card")).toContain(`>${TEST_CONFIG.name}</span>`);
  });

  it("builds the default card gradient from the renamed brand tokens", () => {
    const html = render(docOf(), "card");
    expect(html).toContain("var(--color-brand-accent)");
    expect(html).toContain("var(--color-brand-primary)");
  });
});
