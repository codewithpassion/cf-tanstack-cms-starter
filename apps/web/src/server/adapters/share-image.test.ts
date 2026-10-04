import { describe, expect, it } from "bun:test";

import {
  BROWSER_RUN_HELP,
  isAllowedUrl,
  JPEG_QUALITIES,
  jpegUnderLimit,
  launchBrowser,
  ogRenderUrl,
  SHARE_MAX_BYTES,
  ShareImageError,
} from "./share-image.ts";

describe("isAllowedUrl", () => {
  const ORIGIN = "http://localhost:5173";

  it.each([
    "http://localhost:5173/og-render/cms-test?t=x",
    "http://localhost:5173/assets/app.css",
    "http://localhost:5173/media/abc.jpg",
    "https://fonts.googleapis.com/css2?family=Inter",
    "https://fonts.gstatic.com/s/inter/v1/x.woff2",
    "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    // A blob URL carries the origin of the page that created it.
    "blob:http://localhost:5173/1234",
  ])("lets %s through", (url) => {
    expect(isAllowedUrl(url, ORIGIN)).toBe(true);
  });

  it.each([
    // Analytics must never count a screenshot as a visit.
    "https://www.googletagmanager.com/gtag/js?id=G-TEST",
    "https://region1.google-analytics.com/g/collect",
    "https://www.clarity.ms/tag/test",
    // Anything else third-party, including Clerk and look-alike hosts.
    "https://example-app-1.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
    "https://fonts.googleapis.com.evil.example/x",
    "http://fonts.gstatic.com/s/x.woff2",
    "http://localhost:5174/og-render/cms-test",
    "https://localhost:5173/x",
    "not a url",
  ])("blocks %s", (url) => {
    expect(isAllowedUrl(url, ORIGIN)).toBe(false);
  });
});

describe("jpegUnderLimit", () => {
  it("stops at the first quality under the limit", async () => {
    const tried: number[] = [];
    const result = await jpegUnderLimit((q) => {
      tried.push(q);
      return Promise.resolve(
        new Uint8Array(q >= 75 ? SHARE_MAX_BYTES + 1 : 1000)
      );
    });
    expect(tried).toEqual([85, 75, 65]);
    expect(result.quality).toBe(65);
  });

  it("returns the last attempt when nothing fits", async () => {
    const result = await jpegUnderLimit(
      () => Promise.resolve(new Uint8Array(10)),
      5
    );
    expect<number | undefined>(result.quality).toBe(JPEG_QUALITIES.at(-1));
  });
});

describe("ogRenderUrl", () => {
  it("builds page and home URLs without a trailing slash (the site 301s those)", () => {
    expect(
      ogRenderUrl("http://localhost:5173", "services/new-offer", "t=x")
    ).toBe("http://localhost:5173/og-render/services/new-offer?t=x");
    expect(ogRenderUrl("https://example.com", "", "t=x")).toBe(
      "https://example.com/og-render?t=x"
    );
  });
});

describe("launchBrowser", () => {
  it("turns a launch failure into a ShareImageError that says how to fix it", async () => {
    const err = await launchBrowser(() =>
      Promise.reject(new Error("Failed to launch the browser process"))
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShareImageError);
    expect((err as Error).message).toContain(
      "Failed to launch the browser process"
    );
    expect((err as Error).message).toContain(BROWSER_RUN_HELP);
  });
});
