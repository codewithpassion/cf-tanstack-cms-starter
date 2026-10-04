// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs), as in the source.

import { mediaUrl } from "@repo/cms-core/media";
import { type EffectiveSeo, effectiveSeo } from "@repo/cms-core/seo/checks";
import {
  SHARE_GRADIENTS,
  SHARE_TEMPLATES,
  type ShareGradient,
  type ShareOverrides,
  type ShareTemplate,
} from "@repo/cms-core/share/params";
import type { PublicSiteSeo } from "@repo/cms-core/site/types";
import type { PageDoc, PageKind } from "@repo/cms-core/types";
import { Loader2, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Progress } from "#/components/ui/progress";
import { goToLogin, isUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import {
  LargeShareCard,
  Scaled,
  SquareShareCard,
} from "../seo/previews/previews";
import { useSiteConfig } from "../site/site-context";
import { type MediaInfo, MediaLibrary } from "./media-library";
import { useEditorStore } from "./use-editor-store";

/**
 * "Create share image…" (docs/cms-plan.md §3.9): pick a template, override its text, pick a
 * background, Generate. The server renders /og-render with the page's saved draft and screenshots
 * it with Browser Run (a few seconds), storing a 1200×630 JPEG under 300 KB in the media library;
 * "Use as share image" sets `seo.social.image`. Puppeteer stays on the server: this only calls
 * the server function.
 */

const TEMPLATE_INFO: Record<ShareTemplate, { label: string; hint: string }> = {
  hero: {
    label: "Hero",
    hint: "The page's own hero, reframed to 1200×630 with the site name.",
  },
  card: {
    label: "Card",
    hint: "Eyebrow and headline on a brand background or a library image.",
  },
  post: { label: "Post", hint: "Title, category and author, for blog posts." },
};

const GRADIENT_LABEL: Record<ShareGradient, string> = {
  "primary-glow": "Primary glow",
  "accent-glow": "Accent glow",
  "accent-primary": "Accent + primary",
};

/** Same limits as shareOverridesSchema (share/params.ts). */
const MAX = { eyebrow: 60, headline: 140, category: 40, author: 80, alt: 300 };

const inputClass =
  "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-accent focus:outline-none";

type Result = MediaInfo & { quality: number; bytes: number; alt: string };
type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "generating"; startedAt: number }
  | { kind: "error"; message: string };

function heroProps(doc: PageDoc): { eyebrow?: string; heading?: string } {
  const hero = doc.blocks.find((b) => b._type === "hero");
  return (hero?.props ?? {}) as { eyebrow?: string; heading?: string };
}

export function ShareImageBuilder({
  open,
  onOpenChange,
  pageId,
  kind,
  doc,
  onUse,
  site,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
  kind: PageKind;
  doc: PageDoc;
  onUse: (image: {
    mediaId: string;
    alt: string;
    width: number | null;
    height: number | null;
  }) => boolean;
  /** The site's SEO defaults (title template) for the preview. */
  site?: PublicSiteSeo;
}) {
  const store = useEditorStore();
  const config = useSiteConfig();
  const hero = heroProps(doc);
  const hasHero = doc.blocks.some((b) => b._type === "hero");
  const [template, setTemplate] = useState<ShareTemplate>(
    hasHero ? "hero" : kind === "post" ? "post" : "card"
  );
  const [text, setText] = useState({
    eyebrow: "",
    headline: "",
    category: "",
    author: "",
    alt: "",
  });
  const [gradient, setGradient] = useState<ShareGradient>("accent-primary");
  const [bg, setBg] = useState<MediaInfo | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [result, setResult] = useState<Result | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (phase.kind !== "generating") {
      return;
    }
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [phase.kind]);

  const defaults = {
    eyebrow: hero.eyebrow ?? "",
    headline:
      template === "hero"
        ? (hero.heading ?? doc.seo.title)
        : (doc.seo.social.title ??
          (template === "post"
            ? doc.seo.title
            : (hero.heading ?? doc.seo.title))),
    category: doc.post?.category ?? "",
    author: doc.post?.author ?? "",
  };
  // The headline the image shows: what's typed, else the template's default for this page.
  const altDefault = (text.headline.trim() || defaults.headline).slice(
    0,
    MAX.alt
  );

  const overrides = (): ShareOverrides => {
    const o: ShareOverrides = {};
    const t = (v: string) => v.trim() || undefined;
    if (template !== "post" && t(text.eyebrow)) {
      o.eyebrow = t(text.eyebrow);
    }
    if (t(text.headline)) {
      o.headline = t(text.headline);
    }
    if (template === "post") {
      if (t(text.category)) {
        o.category = t(text.category);
      }
      if (t(text.author)) {
        o.author = t(text.author);
      }
    }
    if (template !== "hero") {
      if (bg) {
        o.bg = bg.id;
      } else {
        o.gradient = gradient;
      }
    }
    return o;
  };

  const busy = phase.kind === "saving" || phase.kind === "generating";

  const generate = async () => {
    setResult(null);
    // The server renders the saved draft: save what's on the canvas first.
    setPhase({ kind: "saving" });
    await store.save();
    const { status } = store.getSnapshot();
    if (store.dirty || status !== "saved") {
      return setPhase({
        kind: "error",
        message:
          "The draft couldn't be saved, so the image would show an older version. Try again once it's saved.",
      });
    }
    setPhase({ kind: "generating", startedAt: Date.now() });
    const alt = text.alt.trim() || altDefault;
    try {
      const media = await getTrpc().cms.shareImage.generateShareImage.mutate({
        pageId,
        template,
        overrides: overrides(),
        alt,
      });
      if (!media.ok) {
        return setPhase({ kind: "error", message: media.message });
      }
      setResult({ ...media, alt });
      setPhase({ kind: "idle" });
    } catch (err) {
      if (isUnauthorized(err)) {
        goToLogin(window.location.pathname + window.location.search);
      }
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const use = () => {
    if (!result) {
      return;
    }
    if (
      onUse({
        mediaId: result.id,
        alt: result.alt,
        width: result.width,
        height: result.height,
      })
    ) {
      toast("Share image set", { description: "Publish to put it live." });
      onOpenChange(false);
    }
  };

  const previewSeo = useMemo<EffectiveSeo | null>(() => {
    if (!result) {
      return null;
    }
    const eff = effectiveSeo(doc, config, site);
    return {
      ...eff,
      image: {
        src: mediaUrl(result.id),
        alt: result.alt,
        mediaId: result.id,
        isDefault: false,
      },
    };
  }, [result, doc, config, site]);

  const elapsed =
    phase.kind === "generating" ? (now - phase.startedAt) / 1000 : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto border-neutral-700 sm:max-w-5xl bg-neutral-900 text-neutral-100"
        data-testid="share-builder"
      >
        <DialogHeader>
          <DialogTitle>Create share image</DialogTitle>
          <DialogDescription>
            A 1200×630 image for LinkedIn, X, Facebook, WhatsApp and Slack,
            rendered from the site's own components. Text left empty comes from
            the page.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-[300px_1fr]">
          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2" disabled={busy}>
              <legend className="mb-1 text-xs font-medium text-neutral-300">
                Template
              </legend>
              {SHARE_TEMPLATES.map((t) => (
                <label
                  key={t}
                  className={`flex cursor-pointer gap-2 rounded border p-2 text-sm ${template === t ? "border-accent bg-neutral-800" : "border-neutral-700"}`}
                >
                  <input
                    type="radio"
                    name="share-template"
                    value={t}
                    checked={template === t}
                    onChange={() => setTemplate(t)}
                    className="mt-1 accent-accent"
                    data-testid={`share-template-${t}`}
                  />
                  <span>
                    <span className="font-medium">
                      {TEMPLATE_INFO[t].label}
                    </span>
                    <span className="block text-xs text-neutral-400">
                      {t === "hero" && !hasHero
                        ? "This page has no hero: renders as Card."
                        : TEMPLATE_INFO[t].hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset className="flex flex-col gap-3" disabled={busy}>
              {template !== "post" && (
                <Field label="Eyebrow" id="share-eyebrow">
                  <input
                    id="share-eyebrow"
                    data-testid="share-eyebrow"
                    className={inputClass}
                    maxLength={MAX.eyebrow}
                    placeholder={defaults.eyebrow}
                    value={text.eyebrow}
                    onChange={(e) =>
                      setText({ ...text, eyebrow: e.target.value })
                    }
                  />
                </Field>
              )}
              <Field
                label={template === "post" ? "Title" : "Headline"}
                id="share-headline"
              >
                <textarea
                  id="share-headline"
                  data-testid="share-headline"
                  rows={2}
                  className={inputClass}
                  maxLength={MAX.headline}
                  placeholder={defaults.headline}
                  value={text.headline}
                  onChange={(e) =>
                    setText({ ...text, headline: e.target.value })
                  }
                />
              </Field>
              {template === "post" && (
                <>
                  <Field label="Category" id="share-category">
                    <input
                      id="share-category"
                      className={inputClass}
                      maxLength={MAX.category}
                      placeholder={defaults.category}
                      value={text.category}
                      onChange={(e) =>
                        setText({ ...text, category: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Author" id="share-author">
                    <input
                      id="share-author"
                      className={inputClass}
                      maxLength={MAX.author}
                      placeholder={defaults.author}
                      value={text.author}
                      onChange={(e) =>
                        setText({ ...text, author: e.target.value })
                      }
                    />
                  </Field>
                </>
              )}
              {template !== "hero" && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-neutral-300">
                    Background
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {SHARE_GRADIENTS.map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => {
                          setBg(null);
                          setGradient(g);
                        }}
                        className={`rounded border px-2 py-1 text-xs ${!bg && gradient === g ? "border-accent text-white" : "border-neutral-700 text-neutral-400"}`}
                        data-testid={`share-gradient-${g}`}
                      >
                        {GRADIENT_LABEL[g]}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setLibraryOpen(true)}
                      className={`rounded border px-2 py-1 text-xs ${bg ? "border-accent text-white" : "border-neutral-700 text-neutral-400"}`}
                    >
                      {bg ? "Image ✓ (change)" : "Library image…"}
                    </button>
                  </div>
                  {!!bg && (
                    <img
                      src={mediaUrl(bg.id)}
                      alt=""
                      width={128}
                      height={64}
                      className="h-16 w-32 rounded object-cover"
                    />
                  )}
                </div>
              )}
              <Field label="Alt text" id="share-alt">
                <input
                  id="share-alt"
                  data-testid="share-alt"
                  className={inputClass}
                  maxLength={MAX.alt}
                  placeholder={altDefault}
                  value={text.alt}
                  onChange={(e) => setText({ ...text, alt: e.target.value })}
                />
              </Field>
            </fieldset>
            <Button
              type="button"
              onClick={generate}
              disabled={busy}
              data-testid="share-generate"
            >
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {phase.kind === "saving"
                ? "Saving draft…"
                : phase.kind === "generating"
                  ? "Generating…"
                  : result
                    ? "Generate again"
                    : "Generate"}
            </Button>
          </div>

          <div
            className="flex min-w-0 flex-col gap-4"
            data-testid="share-result"
          >
            {phase.kind === "generating" && (
              <div
                className="flex flex-col gap-2 rounded border border-neutral-800 p-4"
                role="status"
              >
                <span className="text-sm text-neutral-300">
                  Rendering and screenshotting… {elapsed.toFixed(1)}s
                </span>
                <Progress
                  value={Math.min(95, (elapsed / 4) * 100)}
                  className="h-1.5"
                />
                <span className="text-xs text-neutral-500">
                  Usually about 3 seconds.
                </span>
              </div>
            )}
            {phase.kind === "error" && (
              <p
                className="rounded border border-danger/40 bg-danger/10 p-3 text-sm"
                role="alert"
                data-testid="share-error"
              >
                {phase.message}
              </p>
            )}
            {result && previewSeo ? (
              <>
                <p
                  className="text-xs text-neutral-400"
                  data-testid="share-result-info"
                >
                  {result.width}×{result.height} ·{" "}
                  {Math.round(result.bytes / 1024)} KB · JPEG q{result.quality}
                </p>
                <Scaled width={500}>
                  <LargeShareCard seo={previewSeo} />
                </Scaled>
                <div className="flex flex-wrap items-start gap-4">
                  <Scaled width={400}>
                    <SquareShareCard seo={previewSeo} />
                  </Scaled>
                  <figure className="flex flex-col gap-1">
                    <img
                      src={mediaUrl(result.id)}
                      alt={result.alt}
                      width={300}
                      height={158}
                      className="rounded border border-neutral-700"
                    />
                    <figcaption className="text-[11px] text-neutral-500">
                      At 300px wide: is the text still readable?
                    </figcaption>
                  </figure>
                </div>
              </>
            ) : (
              phase.kind !== "generating" && (
                <div className="flex aspect-[1200/630] items-center justify-center rounded border border-dashed border-neutral-700 text-sm text-neutral-500">
                  Generate to see the image on each platform.
                </div>
              )
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Close
          </Button>
          <Button
            type="button"
            onClick={use}
            disabled={!result || busy}
            data-testid="share-use"
          >
            Use as share image
          </Button>
        </DialogFooter>
        <MediaLibrary
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          selectedId={bg?.id}
          onPick={(m) => setBg(m)}
        />
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-neutral-300">
        {label}
      </label>
      {children}
    </div>
  );
}
