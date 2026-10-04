// biome-ignore-all lint/performance/useTopLevelRegex: ported from the source test; the regexes are not on a hot path.
import { describe, expect, it } from "bun:test";
import {
  BLOCK_TYPES,
  type BlockOverrides,
  type BlockType,
  createBlock,
} from "@repo/cms-core/blocks/registry";
import { pageOutline } from "@repo/cms-core/seo/checks";
import { MEDIA_ID, sampleSeo, TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import type { Block, PageDoc } from "@repo/cms-core/types";
import { renderToString } from "react-dom/server";

import { EditModeContext } from "../render/edit-mode";
import { PageRenderer } from "../render/page-renderer";

/**
 * cms-core's SEO outline (seo/checks.ts `pageOutline`) reads headings, links and images from the
 * props through its per-type maps (HEADING_PROPS, PROP_ELEMENTS) without rendering. These tests
 * render the web Components and fail when the two disagree.
 */

const block = (
  type: BlockType,
  key: string,
  overrides: BlockOverrides = {}
): Block => createBlock(type, { _key: key, ...overrides });

const doc = (blocks: Block[]): PageDoc => ({
  _schema: 1,
  seo: sampleSeo(),
  blocks,
});

describe("pageOutline vs the rendered blocks", () => {
  // Variants that render some props and not others: the outline must agree with what renders.
  const variantFixtures: [string, Block][] = [
    [
      "hero page (no tertiary, no logo)",
      block("hero", "b1", {
        props: {
          variant: "page",
          heading: "H",
          primary: { label: "A", href: "/a" },
          secondary: { label: "B", href: "/b" },
          tertiary: { label: "C", href: "/c" },
          logo: { mediaId: MEDIA_ID, alt: "Logo" },
        },
      }),
    ],
    [
      "hero home",
      block("hero", "b1", {
        props: {
          variant: "home",
          heading: "H",
          primary: { label: "A", href: "/a" },
          tertiary: { label: "C", href: "/c" },
        },
      }),
    ],
    ...(["cards", "plain", "services", "checklist"] as const).map(
      (variant): [string, Block] => [
        `featureGrid ${variant}`,
        block("featureGrid", "b1", {
          props: {
            heading: "H",
            columns: 2,
            variant,
            items: [
              {
                _key: "i1",
                title: "One",
                link: { label: "More", href: "/one" },
              },
            ],
          },
        }),
      ]
    ),
    [
      "cta large",
      block("cta", "b1", {
        props: {
          variant: "large",
          heading: "H",
          primary: { label: "A", href: "/a" },
          link: { label: "L", href: "/l" },
        },
      }),
    ],
  ];

  it.each(variantFixtures)(
    "%s: outline links and headings match what renders",
    (_name, b) => {
      const d = doc([b]);
      const html = renderToString(<PageRenderer doc={d} />);
      const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)]
        .map((m) => m[1])
        .sort();
      const outline = pageOutline(d, TEST_CONFIG);
      expect<unknown>(outline.links.map((l) => l.href).sort()).toEqual(hrefs);
      const rendered = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) =>
        Number(m[1])
      );
      expect<unknown>(outline.headings.map((h) => h.level)).toEqual(rendered);
      // The home hero renders its logo twice (mobile and desktop columns): one image to describe.
      const imgs = [
        ...new Set(
          [...html.matchAll(/<img [^>]*alt="([^"]*)"/g)].map((m) => m[1])
        ),
      ];
      expect<unknown>(outline.images.map((i) => i.alt)).toEqual(imgs);
    }
  );

  // Guards the per-type heading map: what the outline calls H1/H2/H3 is what the blocks render.
  it.each([...BLOCK_TYPES])(
    "%s: outline heading levels match the rendered <h1>-<h3> tags",
    (type) => {
      const b = block(type, "b1");
      const d = doc([b]);
      // A postList with no posts renders nothing on the site, and its cards' titles come from the posts
      // (not the document); render it as the editor does, where it keeps its own heading.
      const html = renderToString(
        <EditModeContext.Provider
          value={{ editing: (type as string) === "postList" }}
        >
          <PageRenderer doc={d} />
        </EditModeContext.Provider>
      );
      const rendered = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) =>
        Number(m[1])
      );
      expect<unknown>(
        pageOutline(d, TEST_CONFIG).headings.map((h) => h.level)
      ).toEqual(rendered);
    }
  );

  // Known cms-core gap: pageOutline reads the home hero's logo as `logo: true` + `logoAlt` (an
  // older shape), but the schema stores `logo: { mediaId, alt }`, so the rendered logo is missing
  // from the outline's images. `failing` flips to a failure once cms-core is fixed: then move the
  // logo into the "hero home" fixture above and delete this test.
  it.failing("hero home: the rendered logo is one outline image", () => {
    const d = doc([
      block("hero", "b1", {
        props: {
          variant: "home",
          heading: "H",
          logo: { mediaId: MEDIA_ID, alt: "Logo" },
        },
      }),
    ]);
    expect(renderToString(<PageRenderer doc={d} />)).toContain('alt="Logo"');
    expect(pageOutline(d, TEST_CONFIG).images.map((i) => i.alt)).toEqual([
      "Logo",
    ]);
  });
});
