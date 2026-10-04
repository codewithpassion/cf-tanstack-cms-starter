// biome-ignore-all lint/complexity/noVoid: `void` marks request-interception promises that are deliberately not awaited, as in the source.
/**
 * `render_preview` screenshots (docs/cms-plan.md §4.3): Browser Run opens
 * `/og-render-agent/<pageId>` with a short-lived "og" token at the device width and takes a JPEG,
 * cropped to one block when asked. Same request allowlist as share images (share-image.ts): only
 * the site's origin and Google Fonts load, so a preview never counts as a visit.
 */
import { DEVICE_WIDTH } from "@repo/cms-core/agent/prompt";
import type { Device } from "@repo/cms-core/types";
import {
  OG_TOKEN_TTL_SECONDS,
  type RenderSigner,
  signRenderToken,
} from "@repo/services/cms/render-token";
import type { PageRow } from "@repo/services/cms/repo";
import { type BrowserBinding, isAllowedUrl } from "./share-image";

const PAGE_TIMEOUT_MS = 20_000;
/** Tall enough for a hero and the next section; the API downsizes anything larger anyway. */
export const MAX_HEIGHT = 2000;
const VIEWPORT_HEIGHT: Record<Device, number> = {
  desktop: 900,
  tablet: 1180,
  mobile: 844,
};
/** Pixels kept above and below a focused block. */
export const CONTEXT_PX = 120;
const QUALITY = 70;

/** Shown when the binding is missing: how to get Browser Run working. */
export const PREVIEW_HELP =
  "Agent previews need Browser Run (the BROWSER binding). In local dev it starts a local Chrome: run `CI=1 bun run dev` on hosts whose kernel blocks Chrome's sandbox. A deployed Worker needs Browser Run on the account.";

export function agentRenderUrl(
  origin: string,
  pageId: string,
  token: string,
  changesetId: string | null
): string {
  const q = new URLSearchParams({
    t: token,
    ...(changesetId && { cs: changesetId }),
  });
  return `${origin}/og-render-agent/${encodeURIComponent(pageId)}?${q}`;
}

/** Where a block (or the whole page) sits in the rendered document, in CSS px. */
export type RenderBox = { top: number; bottom: number; height: number };

/**
 * The screenshot's clip: the whole page from the top, or the focused block with `CONTEXT_PX`
 * around it; never past the page's end and never taller than `MAX_HEIGHT`.
 */
export function screenshotClip(
  box: RenderBox,
  width: number,
  focused: boolean
): { x: number; y: number; width: number; height: number } {
  const top = focused ? Math.max(0, box.top - CONTEXT_PX) : 0;
  const bottom = Math.min(
    box.height,
    focused ? box.bottom + CONTEXT_PX : box.height,
    top + MAX_HEIGHT
  );
  return { x: 0, y: top, width, height: Math.max(1, bottom - top) };
}

export type RenderPreviewDeps = {
  /** The `BROWSER` binding; missing where Browser Run isn't configured. */
  browser?: BrowserBinding;
  signer: RenderSigner;
  /** The site origin Browser Run loads the page from (`SiteConfig.origin`). */
  origin: string;
};

export type RenderPreviewInput = {
  page: Pick<PageRow, "id" | "slug">;
  changesetId: string | null;
  device: Device;
  focusKey?: string;
};

/** A JPEG of the page's draft (or a changeset's proposed page) at the device width. */
export async function renderPreview(
  deps: RenderPreviewDeps,
  input: RenderPreviewInput
): Promise<Uint8Array> {
  if (!deps.browser) {
    throw new Error(
      `Browser Run isn't available, so previews can't be rendered. ${PREVIEW_HELP}`
    );
  }
  const token = await signRenderToken(
    deps.signer,
    { slug: input.page.slug, purpose: "og", pageId: input.page.id },
    { ttlSeconds: OG_TOKEN_TTL_SECONDS }
  );
  const url = agentRenderUrl(
    deps.origin,
    input.page.id,
    token,
    input.changesetId
  );
  const width = DEVICE_WIDTH[input.device];
  // Loaded on first use: Puppeteer is large and only render tools need it.
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  // Puppeteer types its endpoint as `{ fetch: typeof fetch }` (the DOM fetch); the binding's fetch
  // is the Workers one, which takes the same requests (as share-image.ts does).
  const browser = await puppeteer.launch(
    deps.browser as Parameters<typeof puppeteer.launch>[0]
  );
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
    await page.setViewport({
      width,
      height: VIEWPORT_HEIGHT[input.device],
      deviceScaleFactor: 1,
      isMobile: input.device === "mobile",
    });
    await page.setRequestInterception(true);
    const { origin } = new URL(url);
    page.on("request", (req) => {
      if (isAllowedUrl(req.url(), origin)) {
        void req.continue();
      } else {
        void req.abort();
      }
    });
    const response = await page.goto(url, { waitUntil: "load" });
    if (!response?.ok()) {
      throw new Error(
        `The preview page returned ${response ? response.status() : "no response"}.`
      );
    }
    await page.waitForSelector("[data-agent-render]");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
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

    const box = await page.evaluate((key: string | null) => {
      const height = document.documentElement.scrollHeight;
      if (!key) {
        return { top: 0, bottom: height, height };
      }
      const el = document.querySelector(`[data-cms-key="${CSS.escape(key)}"]`);
      if (!el) {
        return null;
      }
      const r = el.getBoundingClientRect();
      return {
        top: r.top + window.scrollY,
        bottom: r.bottom + window.scrollY,
        height,
      };
    }, input.focusKey ?? null);
    if (!box) {
      throw new Error(
        `Block "${input.focusKey}" isn't on the rendered page (hidden at this width?).`
      );
    }
    const clip = screenshotClip(box, width, Boolean(input.focusKey));
    return new Uint8Array(
      await page.screenshot({
        type: "jpeg",
        quality: QUALITY,
        clip,
        captureBeyondViewport: true,
      })
    );
  } finally {
    await browser
      .close()
      .catch((err: unknown) =>
        console.error("Browser Run: closing the browser failed", err)
      );
  }
}
