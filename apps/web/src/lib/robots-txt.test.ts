import { describe, expect, it } from "bun:test";

import { robotsTxt } from "./robots-txt";

const ROBOTS_TXT = robotsTxt({ origin: "https://example.com" });

describe("robots.txt", () => {
  it("allows the site and disallows admin, render targets and the API", () => {
    const lines = ROBOTS_TXT.split("\n");
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Allow: /");
    for (const path of ["/admin", "/og-render", "/og-render-agent", "/api"]) {
      expect(lines).toContain(`Disallow: ${path}`);
    }
  });

  it("points at the sitemap on the configured origin", () => {
    expect(ROBOTS_TXT).toContain("Sitemap: https://example.com/sitemap.xml");
  });
});
