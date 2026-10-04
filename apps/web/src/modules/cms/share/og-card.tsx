// Design knob (docs/architecture.md §11): this file is the share-image look. The frame colours,
// the wordmark badge (the site name from SiteConfig; swap in a logo here if the site has one), the
// headline font and the gradient backgrounds (GRADIENT_BG, keyed by cms-core share/params.ts
// SHARE_GRADIENTS and built from the brand tokens in styles.css) are all set below.
// biome-ignore-all lint/performance/noDelete: the override drops the accent key entirely, as in the source (an undefined value is not the same props).
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; template choice kept as in the source.
import { mediaUrl } from "@repo/cms-core/media";
import type { ShareGradient, ShareParams } from "@repo/cms-core/share/params";
import type { Block, PageDoc, PageKind } from "@repo/cms-core/types";
import { parseBlock } from "@repo/cms-core/validate";
import { AnimatePresence } from "framer-motion";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Divider, Eyebrow, headingPrimary, textColor } from "../blocks/ui";
import { PageRenderer } from "../render/page-renderer";
import { useSiteConfig } from "../site/site-context";

/**
 * The 1200×630 share-image card rendered at /og-render, built from the site's own components and
 * CSS. Browser Run screenshots it once `data-og-ready` is set: after the web fonts have loaded and
 * the content has been scaled to fit the frame.
 *
 * Templates:
 * - hero: the page's first hero block, rendered by the real block component, reframed to 1200×630
 *   with a name badge (the site name as a wordmark). Falls back to `card` when the page has no
 *   hero or its hero doesn't validate.
 * - card: eyebrow and headline on a brand background (a library image or a gradient).
 * - post: title, category and author.
 * Card and post keep their text inside the centred 630px square, so square crops (WhatsApp,
 * Slack) still show it.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const SAFE = OG_HEIGHT; // the centred square
const BADGE_SPACE = 88; // room kept for the logo badge under scaled hero content

type OgCardProps = { doc: PageDoc; kind: PageKind; params: ShareParams };

export function OgCard({ doc, kind, params }: OgCardProps) {
  // Validated (and migrated) up front: an invalid hero would render nothing in the frame.
  const rawHero = doc.blocks.find((b) => b?._type === "hero");
  const hero = rawHero ? parseBlock(rawHero).block : undefined;
  const template =
    params.template === "hero" && !hero ? "card" : params.template;
  return (
    <OgFrame>
      {template === "hero" && hero ? (
        <HeroTemplate doc={doc} hero={hero} params={params} />
      ) : template === "post" ? (
        <PostTemplate doc={doc} kind={kind} params={params} />
      ) : (
        <CardTemplate doc={doc} hero={hero} params={params} />
      )}
      <LogoBadge />
    </OgFrame>
  );
}

/** Fixed 1200×630 frame; marks itself ready once fonts are in and `[data-og-fit]` content fits. */
function OgFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (cancelled || !ref.current) {
        return;
      }
      for (const el of ref.current.querySelectorAll<HTMLElement>(
        "[data-og-fit]"
      )) {
        fitToFrame(el);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="relative overflow-hidden bg-ink font-sans text-white"
      data-og-frame=""
      data-og-ready={ready ? "" : undefined}
      ref={ref}
      style={{ width: OG_WIDTH, height: OG_HEIGHT }}
    >
      {children}
    </div>
  );
}

/** Scales `el` down (never up) so its content fits the frame above the badge. */
function fitToFrame(el: HTMLElement) {
  el.style.transform = "";
  const height = el.scrollHeight;
  const width = el.scrollWidth;
  const scale = Math.min(
    1,
    (OG_HEIGHT - BADGE_SPACE) / height,
    OG_WIDTH / width
  );
  if (scale < 1) {
    el.style.transform = `scale(${scale.toFixed(3)})`;
  }
}

/** The site name (SiteConfig `name`) as a wordmark badge. */
function LogoBadge() {
  const { name } = useSiteConfig();
  return (
    <div className="absolute right-0 bottom-6 left-0 z-20 flex justify-center">
      <div className="flex items-center gap-3 border border-primary/40 bg-ink/80 px-5 py-2">
        <span
          aria-hidden
          className="h-2.5 w-2.5 bg-gradient-to-r from-primary to-accent"
        />
        <span className="font-bold font-heading text-lg text-primary uppercase tracking-widest">
          {name}
        </span>
      </div>
    </div>
  );
}

/**
 * The page's own hero block, rendered as on the public site (no edit-mode markup or placeholders)
 * and centred vertically. It renders static: `AnimatePresence initial={false}` makes every motion
 * component inside start at its final state, so the entrance animations (opacity 0 → 1) can't be
 * caught mid-flight; Puppeteer's injected `animation:none` doesn't reach framer-motion.
 */
function HeroTemplate({
  doc,
  hero,
  params,
}: {
  doc: PageDoc;
  hero: Block;
  params: ShareParams;
}) {
  const props = { ...(hero.props as Record<string, unknown>) };
  if (params.eyebrow) {
    props.eyebrow = params.eyebrow;
  }
  if (params.headline) {
    props.heading = params.headline;
    // The accent words must appear in the heading; an override usually doesn't contain them.
    if (
      typeof props.headingAccent === "string" &&
      !params.headline.includes(props.headingAccent)
    ) {
      delete props.headingAccent;
    }
  }
  // The default 128px top padding is for a page under the nav; here the frame centres the hero.
  const style = {
    ...hero.style,
    padding: {
      desktop: { ...hero.style?.padding?.desktop, top: 32, bottom: 32 },
    },
  };
  const single: PageDoc = { ...doc, blocks: [{ ...hero, props, style }] };
  return (
    <>
      {/* Same backdrop as the public page shell (CmsPage). */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-primary/10 via-transparent to-transparent" />
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-center"
        style={{ height: OG_HEIGHT - BADGE_SPACE }}
      >
        <AnimatePresence initial={false}>
          <div className="w-full origin-center" data-og-fit="" key="hero">
            <PageRenderer doc={single} />
          </div>
        </AnimatePresence>
      </div>
    </>
  );
}

const mix = (token: string, percent: number) =>
  `color-mix(in srgb, var(--color-${token}) ${percent}%, transparent)`;

const GRADIENT_BG: Record<ShareGradient, string> = {
  "primary-glow": `radial-gradient(ellipse at 20% 90%, ${mix("primary", 35)}, transparent 60%), radial-gradient(ellipse at 85% 10%, ${mix("primary-soft", 15)}, transparent 55%)`,
  "accent-glow": `radial-gradient(ellipse at 80% 15%, ${mix("accent", 28)}, transparent 60%), radial-gradient(ellipse at 15% 90%, ${mix("accent", 10)}, transparent 55%)`,
  "accent-primary": `radial-gradient(ellipse at 0% 50%, ${mix("accent", 25)}, transparent 55%), radial-gradient(ellipse at 100% 50%, ${mix("primary", 30)}, transparent 55%)`,
};

function Background({ params }: { params: ShareParams }) {
  if (params.bg) {
    return (
      <>
        <img
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          height={OG_HEIGHT}
          src={mediaUrl(params.bg)}
          width={OG_WIDTH}
        />
        {/* Keeps the text readable on any photo. */}
        <div className="absolute inset-0 bg-gradient-to-b from-ink/70 via-ink/60 to-ink/85" />
      </>
    );
  }
  return (
    <div
      className="absolute inset-0"
      style={{
        backgroundImage: GRADIENT_BG[params.gradient ?? "accent-primary"],
      }}
    />
  );
}

/** Centred text column inside the square safe zone; the align vars centre `.cms-measure` (the divider) as in a centred block. */
const CENTRED = { "--cms-ml-d": "auto", "--cms-mr-d": "auto" } as CSSProperties;

function SafeColumn({ children }: { children: ReactNode }) {
  return (
    <div
      className="absolute inset-y-0 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center justify-center text-center"
      style={{ ...CENTRED, width: SAFE - 30, paddingBottom: 72 }}
    >
      {children}
    </div>
  );
}

/** Headline sized down as it gets longer, so 140 characters still fit four lines. */
function headlineSize(text: string): string {
  if (text.length <= 40) {
    return "text-6xl leading-tight";
  }
  if (text.length <= 80) {
    return "text-5xl leading-tight";
  }
  return "text-4xl leading-snug";
}

function CardTemplate({
  doc,
  hero,
  params,
}: {
  doc: PageDoc;
  hero?: Block;
  params: ShareParams;
}) {
  const heroProps = (hero?.props ?? {}) as {
    eyebrow?: string;
    heading?: string;
  };
  const eyebrow = params.eyebrow ?? heroProps.eyebrow;
  const headline =
    params.headline ??
    doc.seo.social.title ??
    heroProps.heading ??
    doc.seo.title;
  return (
    <>
      <Background params={params} />
      <SafeColumn>
        {!!eyebrow && <Eyebrow field={{}}>{eyebrow}</Eyebrow>}
        <h1
          className={`font-black font-heading ${headlineSize(headline)} ${headingPrimary} mb-6`}
        >
          {headline}
        </h1>
        <Divider />
      </SafeColumn>
    </>
  );
}

function PostTemplate({
  doc,
  kind,
  params,
}: {
  doc: PageDoc;
  kind: PageKind;
  params: ShareParams;
}) {
  const title = params.headline ?? doc.seo.social.title ?? doc.seo.title;
  const category =
    params.category ??
    (kind === "post" ? doc.post?.category : undefined) ??
    params.eyebrow;
  const author =
    params.author ?? (kind === "post" ? doc.post?.author : undefined);
  return (
    <>
      <Background
        params={{ ...params, gradient: params.gradient ?? "primary-glow" }}
      />
      <SafeColumn>
        {!!category && (
          <div className="mb-6 border border-accent/60 px-3 py-1 font-sans text-accent text-sm uppercase tracking-widest">
            {category}
          </div>
        )}
        <h1
          className={`font-black font-heading ${headlineSize(title)} mb-6 text-white`}
        >
          {title}
        </h1>
        <Divider />
        {!!author && (
          <p className={`${textColor} -mt-2 font-sans text-xl`}>By {author}</p>
        )}
      </SafeColumn>
    </>
  );
}
