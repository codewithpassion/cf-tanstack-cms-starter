/**
 * Share-image screenshots (docs/cms-plan.md §3.9). Opens `/og-render/<slug>` with a short-lived
 * "og" token in a Browser Run session (Puppeteer, not a quick action: only our own origin and
 * Google Fonts may load, and the page is normalised before the shot), takes a 1200×630 JPEG of at
 * most 300 KB, and stores it in the media library with source "share-image".
 *
 * Browser Run loads the page from the site's origin (`config.origin`: SITE_ORIGIN, or in dev the
 * origin the admin is on). In local dev the BROWSER binding launches a local Chrome, so that
 * origin can be localhost; a deployed Worker's Browser Run fetches the public URL of the same Worker.
 */

import { slugToPath } from "@repo/cms-core/paths";
import {
  type ShareOverrides,
  type ShareTemplate,
  shareParamsSchema,
  shareRenderQuery,
} from "@repo/cms-core/share/params";
import type { PageDoc } from "@repo/cms-core/types";
import {
  detectImageType,
  imageDimensions,
} from "@repo/services/cms/media-bytes";
import type { MediaInfo } from "@repo/services/cms/media-service";
import {
  OG_TOKEN_TTL_SECONDS,
  signRenderToken,
} from "@repo/services/cms/render-token";
import type { CmsServices } from "../cms/wiring.ts";

export const SHARE_WIDTH = 1200;
export const SHARE_HEIGHT = 630;
export const SHARE_MAX_BYTES = 300 * 1024;
/** Tried in order until the JPEG fits SHARE_MAX_BYTES. */
export const JPEG_QUALITIES = [85, 75, 65, 55] as const;
const MAX_ALT = 300;
/** Applies to every Puppeteer wait (navigation, selectors, evaluate). */
const PAGE_TIMEOUT_MS = 20_000;

/** The web fonts the site loads from Google; every other third-party host is blocked. */
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/**
 * The screenshot browser's request allowlist: this Worker's own origin, Google Fonts, and inline
 * `data:` URLs (Vite inlines small assets). Everything else (analytics, Clerk, any embed) is
 * aborted, so a screenshot never counts as a visit or depends on a third party.
 */
export function isAllowedUrl(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:") {
    return true;
  }
  if (parsed.origin === origin) {
    return true;
  }
  return parsed.protocol === "https:" && FONT_HOSTS.includes(parsed.hostname);
}

export class ShareImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShareImageError";
  }
}

/**
 * Takes JPEGs at falling quality until one is at most `maxBytes`; the last one is returned even if
 * it is still too big, and the caller decides.
 */
export async function jpegUnderLimit(
  shoot: (quality: number) => Promise<Uint8Array>,
  maxBytes: number = SHARE_MAX_BYTES
): Promise<{ bytes: Uint8Array; quality: number }> {
  let last: { bytes: Uint8Array; quality: number } | undefined;
  for (const quality of JPEG_QUALITIES) {
    // biome-ignore lint/performance/noAwaitInLoops: qualities are tried in order, stopping at the first that fits.
    last = { bytes: await shoot(quality), quality };
    if (last.bytes.byteLength <= maxBytes) {
      return last;
    }
  }
  // biome-ignore lint/style/noNonNullAssertion: JPEG_QUALITIES is non-empty, so the loop set it.
  return last!;
}

/** The part of Browser Run's binding that `@cloudflare/puppeteer` uses. */
export type BrowserBinding = Pick<BrowserRun, "fetch">;

/**
 * How to get Browser Run working where it isn't: shown with every launch failure, since the
 * underlying errors (a missing binding, a Chrome that can't start) say little to an editor.
 */
export const BROWSER_RUN_HELP =
  "Share images need Browser Run (the BROWSER binding). In local dev it starts a local Chrome: run `CI=1 bun run dev` on hosts whose kernel blocks Chrome's sandbox. A deployed Worker needs Browser Run on the account.";

/** Starts the screenshot browser; any failure becomes a ShareImageError that says how to fix it. */
export async function launchBrowser<T>(launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (err) {
    console.error("Browser Run: launching the browser failed", err);
    // First line only: a local launch failure carries Chrome's whole log and stack (logged above).
    const [reason] = (err instanceof Error ? err.message : String(err)).split(
      "\n",
      1
    );
    throw new ShareImageError(
      `Browser Run couldn't start a browser (${reason}). ${BROWSER_RUN_HELP}`,
      { cause: err }
    );
  }
}

/** Screenshots `url` at 1200×630, DPR 1, once the page marks itself `[data-og-ready]`. */
export async function screenshotShareImage(
  binding: BrowserBinding,
  url: string
): Promise<{ bytes: Uint8Array; quality: number }> {
  // Loaded on first use: Puppeteer is large and only this admin action needs it.
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const { origin } = new URL(url);
  const browser = await launchBrowser(() =>
    // Puppeteer types its endpoint as `{ fetch: typeof fetch }` (the DOM fetch); the binding's
    // fetch is the Workers one, which takes the same requests.
    puppeteer.launch(binding as Parameters<typeof puppeteer.launch>[0])
  );
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({
      width: SHARE_WIDTH,
      height: SHARE_HEIGHT,
      deviceScaleFactor: 1,
    });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      // `void`: deliberately not awaited, as in the source; the request handler is synchronous.
      if (isAllowedUrl(req.url(), origin)) {
        // biome-ignore lint/complexity/noVoid: marks a promise that is deliberately not awaited.
        void req.continue();
      } else {
        // biome-ignore lint/complexity/noVoid: marks a promise that is deliberately not awaited.
        void req.abort();
      }
    });

    const response = await page.goto(url, { waitUntil: "load" });
    if (!response?.ok()) {
      throw new ShareImageError(
        `The share-image page returned ${response ? response.status() : "no response"}.`
      );
    }
    // Set by OgFrame once fonts are loaded and the content is scaled to fit.
    await page.waitForSelector("[data-og-ready]");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // No caret, transition or animation mid-flight in the shot.
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
    });
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    );

    const clip = { x: 0, y: 0, width: SHARE_WIDTH, height: SHARE_HEIGHT };
    return await jpegUnderLimit(
      async (quality) =>
        new Uint8Array(await page.screenshot({ type: "jpeg", quality, clip }))
    );
  } finally {
    // A failed close must not replace the error (or the result) of the screenshot itself.
    await browser
      .close()
      .catch((err: unknown) =>
        console.error("Browser Run: closing the browser failed", err)
      );
  }
}

export type ShareImageInput = {
  pageId: string;
  template: ShareTemplate;
  overrides?: ShareOverrides;
  /** Defaults to the share title (or the page title). */
  alt?: string;
};

/** The URL Browser Run loads; exported for tests and tooling. */
export function ogRenderUrl(
  origin: string,
  slug: string,
  query: string
): string {
  return `${origin}/og-render${slug ? slugToPath(slug) : ""}?${query}`;
}

function defaultAlt(doc: PageDoc, headline: string | undefined): string {
  return (headline ?? doc.seo.social.title ?? doc.seo.title).slice(0, MAX_ALT);
}

/** The services a share image needs: the page, the render-token key, the media library, the site origin. */
export type ShareImageServices = Pick<
  CmsServices,
  "pages" | "signer" | "media" | "config"
>;

/**
 * Renders the page's draft with `template` and `overrides`, screenshots it and stores the JPEG.
 * `source` "agent" marks images the AI agent rendered (hidden from the library grid by default).
 */
export async function createShareImage(
  env: { BROWSER?: BrowserBinding },
  cms: ShareImageServices,
  input: ShareImageInput & { source?: "share-image" | "agent" }
): Promise<MediaInfo & { quality: number; bytes: number }> {
  const page = await cms.pages.getPage({ id: input.pageId });
  if (!page || page.status === "archived" || !page.draftDoc) {
    throw new ShareImageError("Page not found.");
  }
  const params = shareParamsSchema.parse({
    ...input.overrides,
    template: input.template,
  });

  const token = await signRenderToken(
    cms.signer,
    { slug: page.slug, purpose: "og" },
    { ttlSeconds: OG_TOKEN_TTL_SECONDS }
  );
  const url = ogRenderUrl(
    cms.config.origin,
    page.slug,
    shareRenderQuery(token, params)
  );
  // The binding is missing where Browser Run isn't configured (e.g. a test environment).
  if (!env.BROWSER) {
    throw new ShareImageError(
      `Browser Run isn't available. ${BROWSER_RUN_HELP}`
    );
  }
  const shot = await screenshotShareImage(env.BROWSER, url);

  const type = detectImageType(shot.bytes);
  const size = type && imageDimensions(shot.bytes, type);
  if (
    type?.mime !== "image/jpeg" ||
    size?.width !== SHARE_WIDTH ||
    size.height !== SHARE_HEIGHT
  ) {
    throw new ShareImageError(
      // biome-ignore lint/suspicious/noUnnecessaryConditions: `type` is null for bytes that are no image at all.
      `Expected a ${SHARE_WIDTH}×${SHARE_HEIGHT} JPEG, got ${type?.mime ?? "unknown"} ${size?.width}×${size?.height}.`
    );
  }
  if (shot.bytes.byteLength > SHARE_MAX_BYTES) {
    throw new ShareImageError(
      `The share image is ${Math.round(shot.bytes.byteLength / 1024)} KB even at quality ${shot.quality}.`
    );
  }

  const alt = input.alt?.trim() || defaultAlt(page.draftDoc, params.headline);
  const { media } = await cms.media.uploadMedia({
    bytes: shot.bytes,
    alt,
    source: input.source ?? "share-image",
  });
  return { ...media, quality: shot.quality, bytes: shot.bytes.byteLength };
}
