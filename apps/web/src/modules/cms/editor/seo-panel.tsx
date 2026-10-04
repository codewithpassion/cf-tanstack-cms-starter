// biome-ignore-all lint/a11y/noLabelWithoutControl: the label wraps a shadcn Switch (a button with role="switch"), which biome does not recognise as a control.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, refetch keys), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label and class choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim; each assertion follows a length or membership check.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noArrayIndexKey: the list is rebuilt per render from a fixed array with no ids and is never reordered.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs), as in the source.

import type { EditorPage } from "@repo/cms-core/admin-result";
import { mergePatch } from "@repo/cms-core/ops/json";
import { isValidSlug, slugToPath } from "@repo/cms-core/paths";
import {
  effectiveSeo,
  runSeoChecks,
  type SeoContext,
  seoScore,
  seoWarnings,
} from "@repo/cms-core/seo/checks";
import {
  canvasMeasure,
  DESCRIPTION_FONT_PX,
  DESCRIPTION_MAX_PX,
  type TextMeasure,
  TITLE_FONT_PX,
  TITLE_MAX_PX,
} from "@repo/cms-core/seo/pixel-width";
import { isDecodable, pageSeoSchema } from "@repo/cms-core/seo/schema";
import type { SiteConfig } from "@repo/cms-core/site/config";
import { defaultSiteDoc } from "@repo/cms-core/site/defaults";
import type { PublicSiteSeo } from "@repo/cms-core/site/types";
import type {
  JsonLd,
  MergePatch,
  PageDoc,
  PageSchemaType,
  PageSeo,
} from "@repo/cms-core/types";
import { ChevronRight, ImagePlus } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import { Switch } from "#/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import type { SeoContextResult } from "#/server/trpc/routers/cms/seo";
import { AgentSeoProposals } from "../agent/ui/agent-seo-proposals";
import { SeoPreviews } from "../seo/previews/previews";
import { useSiteConfig } from "../site/site-context";
import { ImageField } from "./media-library";
import type { PublishWarning } from "./publish-dialog";
import { SeoChecklist } from "./seo-checklist";
import { ShareImageBuilder } from "./share-image-builder";
import { signedOutAsResult } from "./signed-out";
import type { EditorStore } from "./store";
import { useEditorState, useEditorStore } from "./use-editor-store";

// Search Console numbers (docs/cms-plan.md §3.10) load as their own chunk when the "Search" tab opens.
const PerformancePanel = lazy(() => import("../gsc/performance-panel"));

/**
 * The page's SEO tab (docs/cms-plan.md §3.9): every `seo` field, the search and share previews,
 * and the checklist. Every change is a `setSeo` op (merge-patch; null clears), so SEO has the same
 * drafts, undo and history as the blocks. Text fields commit after a pause in typing (or on blur,
 * save, publish), so a title typed in one go is one undo step.
 */

type SeoPatch = MergePatch<PageSeo>;

type TextFieldId =
  | "title"
  | "description"
  | "slug"
  | "canonical"
  | "focusKeyphrase"
  | "socialTitle"
  | "socialDescription"
  | "imageAlt"
  | "breadcrumbLabel"
  | "llmsSummary";

type TextField = {
  get: (seo: PageSeo) => string;
  /** null: nothing to change (e.g. alt text without an image). */
  patch: (value: string) => SeoPatch | null;
  max: number;
  validate?: (value: string) => string | null;
};

const orNull = (v: string) => (v.trim() ? v : null);

const TEXT_FIELDS: Record<TextFieldId, TextField> = {
  title: {
    get: (s) => s.title,
    patch: (v) => ({ title: v }),
    max: 200,
    validate: (v) => (v.trim() ? null : "A title is required."),
  },
  description: {
    get: (s) => s.description,
    patch: (v) => ({ description: v }),
    max: 1000,
  },
  slug: {
    get: (s) => s.slug,
    patch: (v) => ({ slug: v.trim() }),
    max: 200,
    validate: (v) =>
      isValidSlug(v.trim())
        ? null
        : "Use lowercase words separated by - and /, e.g. services/new-offer",
  },
  canonical: {
    get: (s) => s.canonical ?? "",
    patch: (v) => ({ canonical: v.trim() || null }),
    max: 2000,
    validate: (v) => {
      if (!v.trim()) {
        return null;
      }
      try {
        if (new URL(v.trim()).protocol !== "https:") {
          return "Use a full https:// URL.";
        }
      } catch {
        return "Use a full https:// URL.";
      }
      return isDecodable(v.trim())
        ? null
        : "The URL has a malformed %-escape (e.g. %E0); fix or remove it.";
    },
  },
  focusKeyphrase: {
    get: (s) => s.focusKeyphrase ?? "",
    patch: (v) => ({ focusKeyphrase: orNull(v) }),
    max: 100,
  },
  socialTitle: {
    get: (s) => s.social.title ?? "",
    patch: (v) => ({ social: { title: orNull(v) } }),
    max: 200,
  },
  socialDescription: {
    get: (s) => s.social.description ?? "",
    patch: (v) => ({ social: { description: orNull(v) } }),
    max: 1000,
  },
  imageAlt: {
    get: (s) => s.social.image?.alt ?? "",
    patch: (v) => ({ social: { image: { alt: v } } }),
    max: 300,
  },
  breadcrumbLabel: {
    get: (s) => s.schema.breadcrumbLabel ?? "",
    patch: (v) => ({ schema: { breadcrumbLabel: orNull(v) } }),
    max: 100,
  },
  llmsSummary: {
    get: (s) => s.llms.summary ?? "",
    patch: (v) => ({ llms: { summary: orNull(v) } }),
    max: 2000,
  },
};

function localError(id: TextFieldId, value: string): string | null {
  const f = TEXT_FIELDS[id];
  if (value.length > f.max) {
    return `At most ${f.max} characters.`;
  }
  return f.validate?.(value) ?? null;
}

const COMMIT_AFTER_MS = 700;

/**
 * Text that couldn't be committed when the SEO tab closed (it has an error), kept for this browser
 * tab under the page's id and shown again with its error the next time the tab opens.
 */
const STASH_PREFIX = "cms-seo-unsaved:";

function takeStash(pageId: string): Partial<Record<TextFieldId, string>> {
  try {
    const raw = sessionStorage.getItem(STASH_PREFIX + pageId);
    if (!raw) {
      return {};
    }
    sessionStorage.removeItem(STASH_PREFIX + pageId);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([id, v]) => Object.hasOwn(TEXT_FIELDS, id) && typeof v === "string"
      )
    ) as Partial<Record<TextFieldId, string>>;
  } catch {
    return {};
  }
}

function putStash(
  pageId: string,
  drafts: Partial<Record<TextFieldId, string>>
) {
  try {
    if (Object.keys(drafts).length) {
      sessionStorage.setItem(STASH_PREFIX + pageId, JSON.stringify(drafts));
    }
  } catch {
    // Storage unavailable: the text is lost, as before.
  }
}

/** Typed-but-uncommitted text per field, their errors, and the commit logic (see the module comment). */
function useSeoDrafts(store: EditorStore, pageId: string) {
  const [drafts, setDrafts] = useState<Partial<Record<TextFieldId, string>>>(
    {}
  );
  const [errors, setErrors] = useState<Partial<Record<TextFieldId, string>>>(
    {}
  );
  const draftsRef = useRef(drafts);
  const timers = useRef(new Map<TextFieldId, ReturnType<typeof setTimeout>>());

  const setDraft = (id: TextFieldId, value: string | undefined) => {
    const next = { ...draftsRef.current };
    if (value === undefined) {
      delete next[id];
    } else {
      next[id] = value;
    }
    draftsRef.current = next;
    setDrafts(next);
  };
  const setError = (id: TextFieldId, message: string | null) =>
    setErrors((e) => {
      if ((e[id] ?? null) === message) {
        return e;
      }
      const next = { ...e };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });

  const commit = useCallback(
    (id: TextFieldId) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      const value = draftsRef.current[id];
      if (value === undefined) {
        return;
      }
      const message = localError(id, value);
      if (message) {
        return setError(id, message);
      }
      const field = TEXT_FIELDS[id];
      const patch = field.patch(value);
      if (!patch || value === field.get(store.getSnapshot().doc.seo)) {
        setDraft(id, undefined);
        return setError(id, null);
      }
      const res = store.apply([{ op: "setSeo", seo: patch }]);
      if (res.ok) {
        setDraft(id, undefined);
        setError(id, null);
      } else {
        setError(id, res.errors[0]?.message ?? "This value can't be saved.");
      }
    },
    [store]
  );

  const change = (id: TextFieldId, value: string) => {
    setDraft(id, value);
    setError(id, localError(id, value));
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => commit(id), COMMIT_AFTER_MS)
    );
  };

  // Save, publish and undo commit what's typed first; so does leaving the tab. Text that can't be
  // committed (it has an error) is stashed on the way out and comes back on the next mount.
  useEffect(() => {
    const restored = takeStash(pageId);
    for (const [id, value] of Object.entries(restored) as [
      TextFieldId,
      string,
    ][]) {
      setDraft(id, value);
      setError(
        id,
        localError(id, value) ??
          "This value couldn't be saved; fix it or clear it."
      );
    }
    const flushAll = () => {
      for (const id of Object.keys(draftsRef.current) as TextFieldId[]) {
        commit(id);
      }
    };
    const unregister = store.registerFlusher(flushAll);
    return () => {
      unregister();
      flushAll();
      putStash(pageId, draftsRef.current);
    };
  }, [store, commit, pageId]);

  return { drafts, errors, change, commit };
}

/** The document with the valid typed values applied, for previews, meters and checks. */
function withDrafts(
  doc: PageDoc,
  drafts: Partial<Record<TextFieldId, string>>,
  errors: Partial<Record<TextFieldId, string>>
): PageDoc {
  let seo = doc.seo;
  for (const [id, value] of Object.entries(drafts) as [TextFieldId, string][]) {
    if (errors[id]) {
      continue;
    }
    const patch = TEXT_FIELDS[id].patch(value);
    if (patch) {
      seo = mergePatch(seo, patch) as PageSeo;
    }
  }
  return seo === doc.seo ? doc : { ...doc, seo };
}

/** cms.seo.getSeoContext while `enabled`, refetched when `refetchKey` changes. */
function useSeoContext(
  pageId: string,
  enabled: boolean,
  refetchKey: unknown
): { ctx: SeoContextResult | null; error: string | null } {
  const [ctx, setCtx] = useState<SeoContextResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    signedOutAsResult(() => getTrpc().cms.seo.getSeoContext.query({ pageId }))
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (res.ok) {
          setCtx(res);
          setError(null);
        } else {
          setError(res.message);
        }
      })
      .catch(
        (err: unknown) =>
          !cancelled &&
          setError(err instanceof Error ? err.message : String(err))
      );
    return () => {
      cancelled = true;
    };
  }, [pageId, enabled, refetchKey]);
  return { ctx, error };
}

/** The checks' context for this page, from the editor (kind, home) and the server (`ctx`). */
function pageSeoContext(
  page: EditorPage["page"],
  ctx: SeoContextResult | null,
  measure: TextMeasure,
  config: SiteConfig
): SeoContext {
  return {
    config,
    pageId: page.id,
    others: ctx?.others,
    media: ctx?.media,
    measure,
    kind: page.kind,
    isHome: page.slug === "",
    site: ctx?.site,
  };
}

/**
 * The SEO checklist's warnings and failures for the publish dialog (warn-only: nothing blocks
 * publishing), measured as the SEO tab measures them. Loads the other pages' titles while `open`.
 */
export function usePublishSeoWarnings(
  page: EditorPage["page"],
  doc: PageDoc,
  open: boolean
): PublishWarning[] {
  const config = useSiteConfig();
  const { ctx } = useSeoContext(page.id, open, open);
  const measure = useMemo(() => canvasMeasure(), []);
  return useMemo(() => {
    if (!open) {
      return [];
    }
    return seoWarnings(doc, pageSeoContext(page, ctx, measure, config)).map(
      (w) => ({
        level: w.level === "fail" ? "error" : "warning",
        message: `SEO · ${w.message}`,
      })
    );
  }, [open, doc, ctx, page, measure, config]);
}

export function SeoPanel({
  pageId,
  page,
}: {
  pageId: string;
  page: EditorPage["page"];
}) {
  const store = useEditorStore();
  const config = useSiteConfig();
  const { doc, pageStatus } = useEditorState();
  const readOnly = pageStatus === "archived";
  const measure = useMemo(() => canvasMeasure(), []);
  const fields = useSeoDrafts(store, pageId);
  const liveDoc = useMemo(
    () => withDrafts(doc, fields.drafts, fields.errors),
    [doc, fields.drafts, fields.errors]
  );
  // Other pages' titles, the share image's size and the live slug; again after a publish.
  const { ctx, error: ctxError } = useSeoContext(pageId, true, pageStatus);
  const [picked, setPicked] = useState<NonNullable<SeoContext["media"]>>({});
  const [tab, setTab] = useState("fields");

  const seoCtx = useMemo<SeoContext>(
    () => ({
      ...pageSeoContext(page, ctx, measure, config),
      media: ctx ? { ...ctx.media, ...picked } : undefined,
    }),
    [page, ctx, picked, measure, config]
  );
  const deferredDoc = useDeferredValue(liveDoc);
  const checks = useMemo(
    () => runSeoChecks(deferredDoc, seoCtx),
    [deferredDoc, seoCtx]
  );
  const score = seoScore(checks);
  const problems = checks.filter(
    (c) => c.status === "fail" || c.status === "warn"
  ).length;
  // The published site's SEO defaults (title template, default image); the built-in ones until loaded.
  const defaultSite = useMemo(() => defaultSiteDoc(config).seo, [config]);
  const site = ctx?.site ?? defaultSite;
  const eff = useMemo(
    () => effectiveSeo(liveDoc, config, site),
    [liveDoc, config, site]
  );

  const applyNow = (patch: SeoPatch) => {
    const res = store.apply([{ op: "setSeo", seo: patch }]);
    if (!res.ok) {
      toast.error(res.errors[0]?.message ?? "That change can't be saved");
    }
    return res.ok;
  };

  const liveSlug = ctx
    ? ctx.liveSlug
    : page.status === "published"
      ? page.slug
      : null;

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex h-full flex-col"
      data-testid="seo-panel"
    >
      <TabsList className="m-2 grid grid-cols-4 bg-neutral-800">
        <TabsTrigger value="fields" data-testid="seo-tab-fields">
          Fields
        </TabsTrigger>
        <TabsTrigger value="previews" data-testid="seo-tab-previews">
          Previews
        </TabsTrigger>
        <TabsTrigger value="checklist" data-testid="seo-tab-checklist">
          Checks
          <span
            className={`ml-1.5 rounded px-1 text-[10px] ${score >= 80 ? "bg-emerald-700/60" : score >= 50 ? "bg-amber-600/50" : "bg-danger/50"}`}
            data-testid="seo-score"
          >
            {score}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="performance"
          data-testid="seo-tab-performance"
          title="Search performance (Google Search Console)"
        >
          Search
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="fields"
        className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-6"
      >
        {!readOnly && <AgentSeoProposals />}
        <fieldset
          disabled={readOnly}
          className="flex min-w-0 flex-col gap-5 pt-1"
          data-testid="seo-fields"
        >
          {readOnly && (
            <p className="text-xs text-neutral-500">
              Archived pages are read-only.
            </p>
          )}
          <SeoFields
            doc={liveDoc}
            committed={doc}
            fields={fields}
            applyNow={applyNow}
            measure={measure}
            pageId={pageId}
            page={page}
            liveSlug={liveSlug}
            media={seoCtx.media ?? {}}
            mediaLoaded={seoCtx.media !== undefined}
            onPicked={(id, size) => setPicked((p) => ({ ...p, [id]: size }))}
            site={site}
            onOpenChecks={() => setTab("checklist")}
            problems={problems}
          />
        </fieldset>
      </TabsContent>
      <TabsContent
        value="previews"
        className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-6"
      >
        <SeoPreviews
          seo={eff}
          measure={measure}
          siteName={site.organization.name}
        />
      </TabsContent>
      <TabsContent
        value="checklist"
        className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-6"
      >
        {!!ctxError && (
          <p className="mb-2 text-xs text-amber-300" role="status">
            Other pages couldn't be loaded ({ctxError}), so uniqueness isn't
            checked.
          </p>
        )}
        <SeoChecklist checks={checks} score={score} />
      </TabsContent>
      <TabsContent
        value="performance"
        className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-6"
      >
        <Suspense
          fallback={<p className="pt-1 text-xs text-neutral-500">Loading…</p>}
        >
          <PerformancePanel pageId={pageId} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------------------------
// Fields

const inputClass =
  "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-accent focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-60";

type Drafts = ReturnType<typeof useSeoDrafts>;

type SlugState =
  | { status: "idle" | "checking" | "ok" }
  | { status: "error"; message: string };

const PAGE_TYPES: { value: PageSchemaType; label: string }[] = [
  { value: "WebPage", label: "Web page" },
  { value: "Service", label: "Service" },
  { value: "LocalBusiness", label: "Local business" },
  { value: "AboutPage", label: "About page" },
  { value: "ContactPage", label: "Contact page" },
  { value: "CollectionPage", label: "Collection page" },
  { value: "Article", label: "Article" },
];

function SeoFields({
  doc,
  committed,
  fields,
  applyNow,
  measure,
  pageId,
  page,
  liveSlug,
  media,
  mediaLoaded,
  onPicked,
  site,
  onOpenChecks,
  problems,
}: {
  doc: PageDoc;
  committed: PageDoc;
  fields: Drafts;
  applyNow: (patch: SeoPatch) => boolean;
  measure: TextMeasure;
  pageId: string;
  page: EditorPage["page"];
  liveSlug: string | null;
  media: NonNullable<SeoContext["media"]>;
  mediaLoaded: boolean;
  onPicked: (
    id: string,
    size: { width: number | null; height: number | null }
  ) => void;
  site: PublicSiteSeo;
  onOpenChecks: () => void;
  problems: number;
}) {
  const { seo } = doc;
  const config = useSiteConfig();
  const eff = effectiveSeo(doc, config, site);
  const [builderOpen, setBuilderOpen] = useState(false);
  const text = (id: TextFieldId) =>
    fields.drafts[id] ?? TEXT_FIELDS[id].get(committed.seo);
  const bind = (id: TextFieldId) => ({
    value: text(id),
    error: fields.errors[id] ?? null,
    onChange: (v: string) => fields.change(id, v),
    onBlur: () => fields.commit(id),
    testId: `seo-${id}`,
  });
  const image = seo.social.image;
  const imageSize = image ? media[image.mediaId] : undefined;
  // `media` holds what the server found; an id it didn't find isn't in the library.
  const imageMissing =
    image !== undefined && mediaLoaded && imageSize === undefined;
  const slugState = useSlugCheck(
    pageId,
    seo.slug,
    fields.errors.slug ? null : (liveSlug ?? page.slug)
  );
  const isHome = committed.seo.slug === "" && page.slug === "";

  return (
    <>
      <button
        type="button"
        onClick={onOpenChecks}
        className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-left text-xs text-neutral-400 hover:border-neutral-600"
      >
        {problems
          ? `${problems} SEO check${problems === 1 ? "" : "s"} need attention →`
          : "All SEO checks pass →"}
      </button>

      <Section title="Search">
        <TextInput label="Title" {...bind("title")} />
        <PixelMeter
          text={eff.title}
          fontPx={TITLE_FONT_PX}
          maxPx={TITLE_MAX_PX}
          measure={measure}
          note={
            seo.titleExact
              ? "Shown exactly as typed."
              : `With the site title template “${site.titleTemplate}”.`
          }
          testId="seo-title-meter"
        />
        <SwitchRow
          label="Exact title (no site name)"
          checked={seo.titleExact === true}
          onChange={(v) => applyNow({ titleExact: v ? true : null })}
          testId="seo-titleExact"
        />
        <TextInput
          label="Meta description"
          multiline
          rows={4}
          {...bind("description")}
        />
        <PixelMeter
          text={seo.description}
          fontPx={DESCRIPTION_FONT_PX}
          maxPx={DESCRIPTION_MAX_PX}
          measure={measure}
          testId="seo-description-meter"
        />
        <TextInput
          label="URL slug"
          prefix="/"
          {...bind("slug")}
          disabled={isHome}
          hint={
            isHome ? (
              "The home page stays at /."
            ) : (
              <SlugHint state={slugState} slug={seo.slug} liveSlug={liveSlug} />
            )
          }
        />
        <TextInput
          label="Canonical URL"
          optional
          placeholder={eff.url}
          {...bind("canonical")}
          hint="Only when another URL is the original of this content."
        />
        <TextInput
          label="Focus keyphrase"
          optional
          {...bind("focusKeyphrase")}
          hint="The search phrase this page should rank for. Used by the checks; never shown on the site."
        />
      </Section>

      <Section title="Indexing">
        <SwitchRow
          label="Let search engines index this page"
          checked={seo.robots.index}
          // Only robots.index: the sitemap setting is kept (a noindex page is left out of the sitemap anyway).
          onChange={(v) => applyNow({ robots: { index: v } })}
          testId="seo-index"
        />
        <SwitchRow
          label="Let search engines follow its links"
          checked={seo.robots.follow}
          onChange={(v) => applyNow({ robots: { follow: v } })}
          testId="seo-follow"
        />
        <SwitchRow
          label="Include in sitemap.xml"
          checked={seo.sitemap.include}
          onChange={(v) => applyNow({ sitemap: { include: v } })}
          testId="seo-sitemap"
        />
        {!seo.robots.index && (
          <p className="text-xs text-amber-300" data-testid="seo-noindex-note">
            noindex pages are left out of the sitemap
            {seo.sitemap.include
              ? "; this page goes back in when it's indexed again"
              : ""}
            .
          </p>
        )}
      </Section>

      <Section title="Social sharing">
        <TextInput
          label="Share title"
          optional
          placeholder={eff.title}
          {...bind("socialTitle")}
        />
        <TextInput
          label="Share description"
          optional
          multiline
          rows={3}
          placeholder={seo.description}
          {...bind("socialDescription")}
        />
        <div data-testid="seo-share-image">
          <ImageField
            label="Share image"
            value={
              image ? { mediaId: image.mediaId, alt: image.alt } : undefined
            }
            onChange={(v) => {
              if (v) {
                onPicked(v.mediaId, {
                  width: v.width ?? null,
                  height: v.height ?? null,
                });
              }
              // The media's own size goes with it (og:image:width/height); null clears the previous image's.
              applyNow({
                social: {
                  image: v
                    ? {
                        mediaId: v.mediaId,
                        alt: v.alt,
                        width: v.width ?? null,
                        height: v.height ?? null,
                      }
                    : null,
                },
              });
            }}
          />
        </div>
        {image ? (
          <p
            className={`text-xs ${imageMissing || (imageSize && (imageSize.width !== 1200 || imageSize.height !== 630)) ? "text-amber-300" : "text-neutral-500"}`}
            data-testid="seo-share-size"
          >
            {imageMissing
              ? "This image isn't in the media library any more; pick another."
              : imageSize
                ? `${imageSize.width ?? "?"}×${imageSize.height ?? "?"}`
                : "Size unknown"}
            {imageSize && (imageSize.width !== 1200 || imageSize.height !== 630)
              ? " — platforms want 1200×630"
              : ""}
          </p>
        ) : (
          <p className="text-xs text-neutral-500">
            None: platforms get the site default image.
          </p>
        )}
        {!!image && (
          <TextInput label="Share image alt text" {...bind("imageAlt")} />
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setBuilderOpen(true)}
          data-testid="open-share-builder"
        >
          <ImagePlus /> Create share image…
        </Button>
      </Section>

      <Section title="Structured data">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="seo-pageType"
            className="text-xs font-medium text-neutral-300"
          >
            Page type
          </label>
          <select
            id="seo-pageType"
            className={inputClass}
            value={seo.schema.pageType}
            data-testid="seo-pageType"
            onChange={(e) =>
              applyNow({
                schema: { pageType: e.target.value as PageSchemaType },
              })
            }
          >
            {PAGE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <TextInput
          label="Breadcrumb label"
          optional
          placeholder={seo.title}
          {...bind("breadcrumbLabel")}
        />
        <ExtraJsonLd extra={seo.schema.extra} applyNow={applyNow} />
      </Section>

      <Section title="llms.txt">
        <SwitchRow
          label="List this page in llms.txt"
          checked={seo.llms.include}
          onChange={(v) => applyNow({ llms: { include: v } })}
          testId="seo-llms"
        />
        <TextInput
          label="Summary for AI assistants"
          optional
          multiline
          rows={3}
          placeholder={seo.description}
          {...bind("llmsSummary")}
        />
      </Section>

      <ShareImageBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        pageId={pageId}
        kind={page.kind}
        doc={doc}
        site={site}
        onUse={(m) => {
          onPicked(m.mediaId, { width: m.width, height: m.height });
          return applyNow({
            social: {
              image: {
                mediaId: m.mediaId,
                alt: m.alt,
                width: m.width,
                height: m.height,
              },
            },
          });
        }}
      />
    </>
  );
}

/** The server's slug rules for a changed slug (reserved, taken, kind); null `own` skips the check. */
function useSlugCheck(
  pageId: string,
  slug: string,
  own: string | null
): SlugState {
  const [state, setState] = useState<SlugState>({ status: "idle" });
  useEffect(() => {
    if (own === null || slug === own || !isValidSlug(slug)) {
      return setState({ status: "idle" });
    }
    setState({ status: "checking" });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await signedOutAsResult(() =>
          getTrpc().cms.seo.checkSeoSlug.query({ pageId, slug })
        );
        if (!cancelled) {
          setState(
            res.ok
              ? { status: "ok" }
              : { status: "error", message: res.message }
          );
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pageId, slug, own]);
  return state;
}

function SlugHint({
  state,
  slug,
  liveSlug,
}: {
  state: SlugState;
  slug: string;
  liveSlug: string | null;
}) {
  return (
    <span className="flex flex-col gap-0.5" data-testid="seo-slug-status">
      {state.status === "checking" && <span>Checking…</span>}
      {state.status === "error" && (
        <span className="text-danger">{state.message}</span>
      )}
      {state.status === "ok" && (
        <span className="text-emerald-300">
          {slugToPath(slug)} is available.
        </span>
      )}
      {liveSlug !== null && slug !== liveSlug && state.status !== "error" && (
        <span className="text-amber-300" data-testid="seo-redirect-note">
          Publishing adds a 301 redirect from {slugToPath(liveSlug)} to{" "}
          {slugToPath(slug)}.
        </span>
      )}
    </span>
  );
}

/** `schema.extra`: a read-only summary, and the JSON behind an "Advanced" toggle (validated with the SEO schema). */
function ExtraJsonLd({
  extra,
  applyNow,
}: {
  extra: JsonLd[] | undefined;
  applyNow: (patch: SeoPatch) => boolean;
}) {
  const current = useMemo(() => JSON.stringify(extra ?? [], null, 2), [extra]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | null>(null);
  // The saved JSON changed (undo, history, another field's op): follow it unless something is being
  // typed here, which is kept, with a note, until it is applied or reverted.
  const [shown, setShown] = useState(current);
  const [stale, setStale] = useState(false);
  if (current !== shown) {
    setShown(current);
    if (text === shown) {
      setText(current);
      setError(null);
      setStale(false);
    } else {
      setStale(true);
    }
  }

  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return setError(
        `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const result = pageSeoSchema.shape.schema.shape.extra.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      return setError(
        `${issue.path.length ? `Node ${issue.path.join(".")}: ` : ""}${issue.message}`
      );
    }
    const nodes = result.data ?? [];
    if (applyNow({ schema: { extra: nodes.length ? nodes : null } })) {
      // Shown as saved from now on, so the saved value it becomes counts as this text.
      setText(JSON.stringify(nodes, null, 2));
      setError(null);
      setStale(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="seo-extra">
      <span className="text-xs font-medium text-neutral-300">
        Extra schema.org nodes
      </span>
      {extra?.length ? (
        <ul
          className="flex flex-col gap-1 text-xs text-neutral-300"
          data-testid="seo-extra-summary"
        >
          {extra.map((node, i) => (
            <li key={i} className="rounded bg-neutral-950 px-2 py-1">
              <span className="font-mono text-accent">
                {String(node["@type"])}
              </span>
              {typeof node.name === "string" && (
                <span className="text-neutral-400"> · {node.name}</span>
              )}
              <span className="text-neutral-500">
                {" "}
                · {Object.keys(node).filter((k) => !k.startsWith("@")).length}{" "}
                fields
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-neutral-500">
          None. Blocks add their own (e.g. FAQ → FAQPage).
        </p>
      )}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex items-center gap-1 text-xs text-neutral-400 hover:text-white"
          data-testid="seo-extra-toggle"
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
          />{" "}
          Advanced: edit JSON
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-2">
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={10}
            spellCheck={false}
            value={text}
            aria-invalid={!!error}
            data-testid="seo-extra-json"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
          {!!error && (
            <p
              className="text-xs text-danger"
              role="alert"
              data-testid="seo-extra-error"
            >
              {error}
            </p>
          )}
          {stale && text !== current && (
            <p className="text-xs text-amber-300" data-testid="seo-extra-stale">
              The saved JSON changed while you were editing; Apply replaces it,
              Revert shows it.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={text === current}
              onClick={apply}
              data-testid="seo-extra-apply"
            >
              Apply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={text === current}
              onClick={() => {
                setText(current);
                setError(null);
              }}
            >
              Revert
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Small controls

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="border-b border-neutral-800 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

function TextInput({
  label,
  value,
  error,
  onChange,
  onBlur,
  testId,
  multiline,
  rows,
  placeholder,
  optional,
  hint,
  prefix,
  disabled,
}: {
  label: string;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onBlur: () => void;
  testId: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  optional?: boolean;
  hint?: ReactNode;
  prefix?: string;
  disabled?: boolean;
}) {
  const props = {
    id: testId,
    value,
    placeholder,
    disabled,
    "aria-invalid": !!error,
    "data-testid": testId,
    className: inputClass,
    onBlur,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={testId} className="text-xs font-medium text-neutral-300">
        {label}
        {!!optional && (
          <span className="font-normal text-neutral-500"> (optional)</span>
        )}
      </label>
      {multiline ? (
        <textarea rows={rows} {...props} />
      ) : prefix ? (
        <div className="flex items-center gap-1">
          <span className="text-neutral-500">{prefix}</span>
          <input {...props} />
        </div>
      ) : (
        <input {...props} />
      )}
      {!!error && (
        <p
          className="text-xs text-danger"
          role="alert"
          data-testid={`${testId}-error`}
        >
          {error}
        </p>
      )}
      {!!hint && <div className="text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-neutral-200">
      <span className={disabled ? "text-neutral-500" : ""}>{label}</span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        data-testid={testId}
      />
    </label>
  );
}

/** Width of the text as Google renders it, against the cut-off. */
function PixelMeter({
  text,
  fontPx,
  maxPx,
  measure,
  note,
  testId,
}: {
  text: string;
  fontPx: number;
  maxPx: number;
  measure: TextMeasure;
  note?: string;
  testId: string;
}) {
  const width = Math.round(measure(text, fontPx));
  const ratio = width / maxPx;
  const color = width
    ? ratio > 1
      ? "bg-danger"
      : ratio < 0.5
        ? "bg-amber-500"
        : "bg-emerald-500"
    : "bg-neutral-700";
  return (
    <div
      className="-mt-1 flex flex-col gap-1"
      data-testid={testId}
      data-width={width}
    >
      <div className="h-1.5 overflow-hidden rounded bg-neutral-800">
        <div
          className={`h-full ${color}`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-neutral-500">
        <span>{note}</span>
        <span className={ratio > 1 ? "text-danger" : ""}>
          {width} / {maxPx}px{ratio > 1 ? " — cut off in Google" : ""}
        </span>
      </div>
    </div>
  );
}
