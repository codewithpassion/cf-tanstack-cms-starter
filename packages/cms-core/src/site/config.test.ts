import { describe, expect, it } from "bun:test";

import { siteConfig } from "./config";

const EMPTY_RE = /empty/;
const VALID_URL_RE = /valid URL/;
const HTTP_RE = /http/;

describe("siteConfig", () => {
  it("trims, strips trailing slashes and nulls a missing property", () => {
    expect(
      siteConfig({ name: "  Acme ", origin: " https://acme.test// " })
    ).toEqual({ name: "Acme", origin: "https://acme.test", gscProperty: null });
    expect(
      siteConfig({
        name: "A",
        origin: "http://localhost:3000",
        gscProperty: " sc-domain:acme.test ",
      }).gscProperty
    ).toBe("sc-domain:acme.test");
    expect(
      siteConfig({ name: "A", origin: "https://a.test", gscProperty: "" })
        .gscProperty
    ).toBeNull();
  });

  it("throws on an empty, malformed or non-http(s) origin", () => {
    expect(() => siteConfig({ name: "A", origin: "  /" })).toThrow(EMPTY_RE);
    expect(() => siteConfig({ name: "A", origin: "example.com" })).toThrow(
      VALID_URL_RE
    );
    expect(() =>
      siteConfig({ name: "A", origin: "ftp://example.com" })
    ).toThrow(HTTP_RE);
  });
});
