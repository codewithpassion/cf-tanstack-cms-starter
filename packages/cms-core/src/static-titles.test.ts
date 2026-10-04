import { describe, expect, it } from "bun:test";

import { STATIC_PAGE_SLUGS } from "./reserved";
import { staticPageTitles } from "./static-titles";

describe("staticPageTitles", () => {
  const titles = staticPageTitles({ name: "Example Site" });

  it("has a title for every static page, and only those", () => {
    expect(Object.keys(titles).sort()).toEqual([...STATIC_PAGE_SLUGS].sort());
  });

  it("derives the titles from the site name", () => {
    expect(titles.blog).toBe("Blog | Example Site");
    expect(titles.login).toBe("Example Site");
  });
});
