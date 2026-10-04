import { describe, expect, it } from "bun:test";

import { bareTitle, withBareTitles } from "./stage";
import type { SeoProposal } from "./types";

// Agent titles that already carry the title template's text ("… | Acme | Acme").
const TEMPLATE = "%s | Acme Studio";

describe("bareTitle", () => {
  it("drops a trailing copy of the template's suffix, case-insensitively, and nothing else", () => {
    expect(bareTitle("Services | Acme Studio", TEMPLATE)).toBe("Services");
    expect(bareTitle("Services | acme studio ", TEMPLATE)).toBe("Services");
    expect(bareTitle("Services", TEMPLATE)).toBe("Services");
    expect(bareTitle("Acme Studio services", TEMPLATE)).toBe(
      "Acme Studio services"
    );
    // A title that is only the suffix stays as it is.
    expect(bareTitle("| Acme Studio", TEMPLATE)).toBe("| Acme Studio");
    expect(bareTitle("Acme Studio · About", "Acme Studio · %s")).toBe("About");
    expect(bareTitle("Anything | X", "%s")).toBe("Anything | X");
  });
});

describe("withBareTitles", () => {
  const proposal: SeoProposal = {
    seo: {
      focusKeyphrase: "team services",
      title: "Services | Acme Studio",
    },
    variants: [
      { title: "Team services | Acme Studio", description: "d1" },
      { title: "Services for your team", description: "d2" },
    ],
  };

  it("strips the suffix from the seo title and every variant, and counts what changed", () => {
    const res = withBareTitles(proposal, TEMPLATE, undefined);
    expect(res.stripped).toBe(2);
    expect(res.proposal.seo.title).toBe("Services");
    expect(res.proposal.variants.map((v) => v.title)).toEqual([
      "Team services",
      "Services for your team",
    ]);
    expect(res.proposal.variants[0]?.description).toBe("d1");
  });

  it("leaves exact titles alone (the proposal's titleExact, else the page's)", () => {
    expect(
      withBareTitles(
        { ...proposal, seo: { ...proposal.seo, titleExact: true } },
        TEMPLATE,
        false
      ).stripped
    ).toBe(0);
    expect(withBareTitles(proposal, TEMPLATE, true)).toEqual({
      proposal,
      stripped: 0,
    });
    expect(
      withBareTitles(
        { ...proposal, seo: { ...proposal.seo, titleExact: false } },
        TEMPLATE,
        true
      ).stripped
    ).toBe(2);
  });
});
