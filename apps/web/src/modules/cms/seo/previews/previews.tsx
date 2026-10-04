// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: the favicon's onError only hides a missing image; nothing to interact with.
// biome-ignore-all lint/correctness/useImageSize: preview images are sized by their CSS classes (aspect ratio and width of the card).
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim; admin-only previews are not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noReturnAssign: ported verbatim; the onError arrow hides the image.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: a ref can be null before mount, as in the source.
import type { EffectiveSeo } from "@repo/cms-core/seo/checks";
import {
  DESCRIPTION_FONT_PX,
  DESCRIPTION_MAX_PX,
  type TextMeasure,
  TITLE_FONT_PX,
  TITLE_MAX_PX,
  truncateToWidth,
} from "@repo/cms-core/seo/pixel-width";
import { Globe } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { useSiteConfig } from "../../site/site-context";

/**
 * Search and share previews for the SEO tab: Google desktop and mobile, the large 1.91:1 card
 * LinkedIn, X and Facebook show, and the square crop WhatsApp and Slack show. Approximations of
 * each platform's layout, fed with the effective values (template, social fallbacks, site default
 * image), so they show what the head will say. The domain the share cards print is the host of
 * SiteConfig `origin` (site-context.ts).
 */

/** The host the share cards print, from the SiteConfig origin. */
function useHost(): string {
  return new URL(useSiteConfig().origin).host;
}

const ARIAL = { fontFamily: "Arial, Helvetica, sans-serif" };

/** A path segment as people read it; a malformed escape ("%E0") is shown as typed. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** "https://host/services/x" → "https://host › services › x", as Google prints URLs. */
export function googleBreadcrumb(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeSegment);
  return [`${parsed.protocol}//${parsed.host}`, ...parts].join(" › ");
}

/** Lays out `children` at `width` px and scales the whole thing down to fit its container. */
export function Scaled({
  width,
  children,
}: {
  width: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const update = () => setScale(Math.min(1, el.clientWidth / width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={ref} className="w-full overflow-hidden">
      <div style={{ width, zoom: scale }}>{children}</div>
    </div>
  );
}

function Favicon() {
  return (
    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-[#dadce0] bg-white">
      <img
        src="/favicon.ico"
        alt=""
        width={18}
        height={18}
        className="h-[18px] w-[18px]"
        onError={(e) => (e.currentTarget.style.display = "none")}
      />
    </span>
  );
}

/** `siteName`: the name Google prints above the URL (the site's organization name). */
export function GooglePreview({
  seo,
  device,
  measure,
  siteName,
}: {
  seo: EffectiveSeo;
  device: "desktop" | "mobile";
  measure: TextMeasure;
  siteName: string;
}) {
  const title = truncateToWidth(
    seo.title,
    TITLE_MAX_PX,
    TITLE_FONT_PX,
    measure
  );
  const description = truncateToWidth(
    seo.description,
    DESCRIPTION_MAX_PX,
    DESCRIPTION_FONT_PX,
    measure
  );
  const desktop = device === "desktop";
  return (
    <div
      className={`rounded-lg bg-white text-left ${desktop ? "p-4" : "p-3 shadow-[0_1px_6px_rgba(32,33,36,0.28)]"}`}
      style={{ ...ARIAL, width: desktop ? 632 : 360 }}
      data-testid={`google-preview-${device}`}
    >
      <div className="flex items-center gap-3">
        <Favicon />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[14px] text-[#202124]">{siteName}</div>
          <div className="truncate text-[12px] text-[#4d5156]">
            {googleBreadcrumb(seo.url)}
          </div>
        </div>
      </div>
      <div
        className={`mt-1.5 ${desktop ? "whitespace-nowrap text-[20px] leading-[26px]" : "line-clamp-2 text-[18px] leading-[24px]"} text-[#1a0dab]`}
        data-testid={`google-title-${device}`}
      >
        {desktop ? title.text : seo.title}
      </div>
      <div
        className={`mt-1 text-[14px] leading-[22px] text-[#4d5156] ${desktop ? "" : "line-clamp-3"}`}
      >
        {seo.description ? (
          desktop ? (
            description.text
          ) : (
            seo.description
          )
        ) : (
          <i className="text-[#70757a]">Google picks text from the page</i>
        )}
      </div>
      {!seo.index && (
        <div className="mt-2 text-[12px] font-bold text-[#c5221f]">
          noindex: this page won't appear in search
        </div>
      )}
    </div>
  );
}

function ShareImage({
  seo,
  className,
}: {
  seo: EffectiveSeo;
  className: string;
}) {
  return seo.image.src ? (
    <img
      src={seo.image.src}
      alt={seo.image.alt}
      className={`${className} bg-neutral-800 object-cover`}
    />
  ) : (
    <div
      className={`${className} flex items-center justify-center bg-neutral-800`}
    >
      <Globe className="h-8 w-8 text-neutral-500" />
    </div>
  );
}

/** LinkedIn / X / Facebook: the full 1200×630 image (1.91:1) over the title and domain. */
export function LargeShareCard({ seo }: { seo: EffectiveSeo }) {
  const host = useHost();
  return (
    <div
      className="overflow-hidden rounded-lg border border-[#dadde1] bg-white text-left"
      style={{ ...ARIAL, width: 500 }}
      data-testid="share-card-large"
    >
      <ShareImage seo={seo} className="aspect-[1200/630] w-full" />
      <div className="border-t border-[#dadde1] bg-[#f2f3f5] px-3 py-2">
        <div className="text-[12px] uppercase text-[#606770]">{host}</div>
        <div className="line-clamp-2 text-[16px] font-semibold leading-[20px] text-[#1d2129]">
          {seo.shareTitle}
        </div>
        <div className="line-clamp-1 text-[14px] leading-[20px] text-[#606770]">
          {seo.shareDescription}
        </div>
      </div>
    </div>
  );
}

/** WhatsApp / Slack: a square crop from the centre of the image beside the text. */
export function SquareShareCard({ seo }: { seo: EffectiveSeo }) {
  const host = useHost();
  return (
    <div
      className="flex overflow-hidden rounded-lg border border-[#d1d7db] bg-[#f0f2f5] text-left"
      style={{ ...ARIAL, width: 400 }}
      data-testid="share-card-square"
    >
      <ShareImage
        seo={seo}
        className="aspect-square w-[110px] shrink-0 object-center"
      />
      <div className="min-w-0 px-3 py-2">
        <div className="line-clamp-2 text-[14px] font-semibold leading-[19px] text-[#111b21]">
          {seo.shareTitle}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[13px] leading-[17px] text-[#667781]">
          {seo.shareDescription}
        </div>
        <div className="mt-1 text-[12px] text-[#8696a0]">{host}</div>
      </div>
    </div>
  );
}

/** All four previews with headings, scaled to the panel's width. */
export function SeoPreviews({
  seo,
  measure,
  siteName,
}: {
  seo: EffectiveSeo;
  measure: TextMeasure;
  siteName: string;
}) {
  return (
    <div className="flex flex-col gap-5" data-testid="seo-previews">
      <PreviewSection title="Google · desktop">
        <Scaled width={632}>
          <GooglePreview
            seo={seo}
            device="desktop"
            measure={measure}
            siteName={siteName}
          />
        </Scaled>
      </PreviewSection>
      <PreviewSection title="Google · mobile">
        <Scaled width={360}>
          <GooglePreview
            seo={seo}
            device="mobile"
            measure={measure}
            siteName={siteName}
          />
        </Scaled>
      </PreviewSection>
      <PreviewSection title="LinkedIn · X · Facebook (1.91:1)">
        <Scaled width={500}>
          <LargeShareCard seo={seo} />
        </Scaled>
      </PreviewSection>
      <PreviewSection title="WhatsApp · Slack (square crop)">
        <Scaled width={400}>
          <SquareShareCard seo={seo} />
        </Scaled>
      </PreviewSection>
      {!!seo.image.isDefault && (
        <p className="text-xs text-neutral-500">
          No share image set: platforms get the site default.
        </p>
      )}
    </div>
  );
}

function PreviewSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {title}
      </h3>
      {children}
    </section>
  );
}
