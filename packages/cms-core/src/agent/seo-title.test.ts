import { describe, expect, it } from "bun:test";

import { bareTitle, withBareTitles } from "./stage";
import type { SeoProposal } from "./types";

// Agent titles that already carry the title template's text ("… | Acme | Acme").
const TEMPLATE = "%s | Acme Studio";

describe("bareTitle", () => {
  it("drops a trailing copy of the template's suffix, case-insensitively, and nothing else", () => {
    expect(bareTitle("Workshops | Acme Studio", TEMPLATE)).toBe("Workshops");
    expect(bareTitle("Workshops | acme studio ", TEMPLATE)).toBe("Workshops");
    expect(bareTitle("Workshops", TEMPLATE)).toBe("Workshops");
    expect(bareTitle("Acme Studio workshops", TEMPLATE)).toBe(
      "Acme Studio workshops"
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
      focusKeyphrase: "team workshops",
      title: "Workshops | Acme Studio",
    },
    variants: [
      { title: "Team workshops | Acme Studio", description: "d1" },
      { title: "Workshops for your team", description: "d2" },
    ],
  };

  it("strips the suffix from the seo title and every variant, and counts what changed", () => {
    const res = withBareTitles(proposal, TEMPLATE, undefined);
    expect(res.stripped).toBe(2);
    expect(res.proposal.seo.title).toBe("Workshops");
    expect(res.proposal.variants.map((v) => v.title)).toEqual([
      "Team workshops",
      "Workshops for your team",
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
