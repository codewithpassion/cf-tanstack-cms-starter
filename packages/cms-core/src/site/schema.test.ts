// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noReturnAssign: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";
import { TEST_CONFIG } from "../test-fixtures";
import { defaultSiteDoc } from "./defaults";
import { SITE_LIMITS, validateSiteDoc } from "./schema";
import { siteChanges, summarizeSiteChange } from "./summary";
import { TEST_SITE } from "./test-site";
import type { SiteDoc } from "./types";

const edit = (fn: (d: SiteDoc) => void): SiteDoc => {
  // The fuller test doc (test-site.ts): the minimal defaults have one nav link and one column.
  const d = structuredClone(TEST_SITE);
  fn(d);
  return d;
};
const errorsOf = (doc: unknown) => {
  const r = validateSiteDoc(doc);
  return r.ok ? [] : r.errors;
};

const DEFAULT_SITE_DOC = defaultSiteDoc(TEST_CONFIG);

describe("site doc schema", () => {
  it("accepts the defaults unchanged", () => {
    expect(validateSiteDoc(DEFAULT_SITE_DOC)).toEqual({
      ok: true,
      doc: DEFAULT_SITE_DOC,
    });
    expect(validateSiteDoc(TEST_SITE)).toEqual({ ok: true, doc: TEST_SITE });
  });

  it("rejects unsafe links, with the field's path", () => {
    expect(
      errorsOf(edit((d) => (d.nav.links[1]!.href = "javascript:alert(1)")))[0]!
        .path
    ).toBe("nav.links[1].href");
    expect(
      errorsOf(
        edit((d) => (d.footer.columns[0]!.links[0]!.href = "//evil.example"))
      )[0]!.path
    ).toBe("footer.columns[0].links[0].href");
    expect(
      errorsOf(edit((d) => (d.nav.cta.href = "http://plain.example")))[0]!.path
    ).toBe("nav.cta.href");
  });

  it("rejects $, { and } in links (the router reads them as route params)", () => {
    expect(
      errorsOf(edit((d) => (d.nav.links[1]!.href = "/services/$slug")))[0]!
    ).toEqual({
      path: "nav.links[1].href",
      message: "Links can't contain $, { or }",
    });
    expect(errorsOf(edit((d) => (d.nav.cta.href = "/a{b}")))[0]!.path).toBe(
      "nav.cta.href"
    );
    expect(
      errorsOf(
        edit(
          (d) => (d.footer.legalLinks[0]!.href = "https://x.example/?q=${y}")
        )
      )[0]!.path
    ).toBe("footer.legalLinks[0].href");
    expect(
      errorsOf(
        edit(
          (d) =>
            (d.nav.links[0]!.children = [
              { _key: "c", label: "C", href: "/c$" },
            ])
        )
      )[0]!.path
    ).toBe("nav.links[0].children[0].href");
  });

  it("accepts external, mailto and dropdown links", () => {
    const doc = edit((d) => {
      d.nav.links[1]!.children = [
        { _key: "c1", label: "Sprint", href: "/services/automation-sprint" },
      ];
      d.footer.legalLinks.push({
        _key: "mail",
        label: "Email",
        href: "mailto:hello@example.com",
      });
      d.footer.columns[0]!.links.push({
        _key: "li",
        label: "LinkedIn",
        href: "https://linkedin.com/in/janedoe",
      });
    });
    expect(validateSiteDoc(doc).ok).toBe(true);
  });

  it("rejects duplicate keys, empty labels, unknown keys and too many links", () => {
    expect(
      errorsOf(edit((d) => (d.nav.links[1]!._key = d.nav.links[0]!._key)))[0]!
    ).toEqual({ path: "nav.links[1]._key", message: "Duplicate key" });
    expect(errorsOf(edit((d) => (d.nav.links[0]!.label = "  ")))[0]!.path).toBe(
      "nav.links[0].label"
    );
    expect(errorsOf({ ...TEST_SITE, theme: "dark" })[0]!.message).toMatch(
      /theme/
    );
    const many = edit((d) => {
      d.nav.links = Array.from(
        { length: SITE_LIMITS.navLinks + 1 },
        (_, i) => ({ _key: `k${i}`, label: "x", href: "/" })
      );
    });
    expect(errorsOf(many)[0]!.path).toBe("nav.links");
  });

  it("needs %s exactly once in the title template", () => {
    expect(
      errorsOf(edit((d) => (d.seo.titleTemplate = "Example")))[0]!.path
    ).toBe("seo.titleTemplate");
    expect(
      errorsOf(edit((d) => (d.seo.titleTemplate = "%s | %s")))[0]!.path
    ).toBe("seo.titleTemplate");
    expect(
      validateSiteDoc(edit((d) => (d.seo.titleTemplate = "ACME — %s"))).ok
    ).toBe(true);
  });

  it("checks swatches, the share image and organization URLs", () => {
    expect(
      errorsOf(edit((d) => (d.swatches = [{ _key: "a", hex: "red" }])))[0]!.path
    ).toBe("swatches[0].hex");
    expect(
      errorsOf(edit((d) => (d.seo.defaultShareImage.mediaId = "../x.png")))[0]!
        .path
    ).toBe("seo.defaultShareImage.mediaId");
    expect(
      errorsOf(edit((d) => (d.seo.defaultShareImage.url = "#top")))[0]!.path
    ).toBe("seo.defaultShareImage.url");
    expect(
      errorsOf(
        edit((d) => (d.seo.organization.sameAs = ["linkedin.com/x"]))
      )[0]!.path
    ).toBe("seo.organization.sameAs[0]");
  });
});

describe("site change summary", () => {
  it("is empty for no change", () => {
    // Not in the source: a new nav item's dropdown links are named too.
    const withDropdown = edit((d) => {
      d.nav.links.push({
        _key: "new",
        label: "Company",
        href: "/company",
        children: [{ _key: "c1", label: "About", href: "/about" }],
      });
    });
    expect(siteChanges(TEST_SITE, withDropdown)).toEqual([
      "Nav: added “Company”",
      "Nav “Company” dropdown: added “About”",
    ]);
    expect(
      siteChanges(DEFAULT_SITE_DOC, structuredClone(DEFAULT_SITE_DOC))
    ).toEqual([]);
    expect(summarizeSiteChange(DEFAULT_SITE_DOC, DEFAULT_SITE_DOC)).toBe(
      "No changes"
    );
  });

  it("names nav, footer, SEO and swatch changes", () => {
    const after = edit((d) => {
      d.nav.links.push({ _key: "x", label: "CMS Test", href: "/cms-test" });
      d.nav.links[0]!.label = "Start";
      [d.nav.links[1], d.nav.links[2]] = [d.nav.links[2]!, d.nav.links[1]!];
      d.footer.columns.splice(2, 1);
      d.footer.columns[1]!.title = "What we do";
      d.footer.columns[1]!.links[0]!.href = "/services/sprint";
      d.seo.titleTemplate = "%s — ACME";
      d.seo.twitterCard = "summary";
      d.swatches.push({ _key: "s", hex: "#112233" });
    });
    expect(siteChanges(TEST_SITE, after)).toEqual([
      "Nav: added “CMS Test”",
      "Nav: renamed “Home” → “Start”",
      "Nav: reordered",
      "Footer: removed column “Locations”",
      "Footer: renamed column “Services” → “What we do”",
      "Footer “What we do”: “Service One” link → /services/sprint",
      "SEO: title template → “%s — ACME”",
      "SEO: twitter:card → summary",
      "Swatches: added 1",
    ]);
  });
});
