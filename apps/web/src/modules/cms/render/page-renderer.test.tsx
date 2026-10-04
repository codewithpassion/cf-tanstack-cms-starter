import { describe, expect, it } from "bun:test";
import { sampleDoc } from "@repo/cms-core/test-fixtures";
import { renderToString } from "react-dom/server";

import { EditModeContext } from "./edit-mode";
import { PageRenderer } from "./page-renderer";

function docWithBadBlocks() {
  const doc = sampleDoc();
  doc.blocks.push(
    {
      _key: "unknown1",
      _type: "carousel",
      _v: 1,
      props: { heading: "Unknown block text" },
    },
    {
      _key: "bad1",
      _type: "cta",
      _v: 1,
      props: { heading: "Invalid CTA text" },
    },
    {
      _key: "badstyle",
      _type: "richText",
      _v: 1,
      props: {
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Styled prose" }],
            },
          ],
        },
      },
      style: { background: { color: { hex: "red;position:fixed" } } },
    }
  );
  return doc;
}

describe("PageRenderer", () => {
  const html = renderToString(<PageRenderer doc={docWithBadBlocks()} />);

  it("renders blocks with their style vars and attrs", () => {
    expect(html).toContain("Hello CMS");
    expect(html).toContain('class="cms-block"');
    // hero: the user set padding.top (mobile only), so its default is ignored; padding.bottom keeps it
    const hero = html.slice(0, html.indexOf("</section>"));
    expect(hero).not.toContain("--cms-pt-d");
    expect(hero).toContain("--cms-pt-m:48px");
    expect(hero).toContain("--cms-pb-d:80px");
    expect(html).toContain("--cms-heading:var(--color-brand-accent)");
    // hero heading element: mobile-only size
    expect(html).toContain('data-cms-fs="m"');
    expect(html).toContain("--cms-e-fs-m:1.5rem");
    // featureGrid hidden on tablet (and mobile, by cascade), glow border
    expect(html).toContain('data-cms-hide-t="" data-cms-hide-m=""');
    expect(html).toContain('data-cms-border="glow"');
  });

  it("emits no edit attributes outside the editor", () => {
    expect(html).not.toContain("data-cms-block");
    expect(html).not.toContain("data-cms-key");
    expect(html).not.toContain("data-cms-field");
  });

  it("renders nothing for unknown or invalid blocks, and drops an invalid style", () => {
    expect(html).not.toContain("Unknown block text");
    expect(html).not.toContain("Invalid CTA text");
    expect(html).not.toContain("Can&#x27;t render");
    expect(html).toContain("Styled prose");
    expect(html).not.toContain("position:fixed");
  });

  it("adds edit attributes and placeholders in edit mode, with animations off", () => {
    const edit = renderToString(
      <EditModeContext.Provider value={{ editing: true, device: "mobile" }}>
        <PageRenderer doc={docWithBadBlocks()} />
      </EditModeContext.Provider>
    );
    expect(edit).toContain('data-cms-block="hero"');
    expect(edit).toContain('data-cms-key="hero1"');
    expect(edit).toContain('data-cms-field="heading"');
    expect(edit).toContain("Unknown block type");
    expect(edit).toContain('data-cms-key="bad1"');
    expect(edit).not.toContain("opacity:0");
    expect(html).toContain("opacity:0");
  });
});
