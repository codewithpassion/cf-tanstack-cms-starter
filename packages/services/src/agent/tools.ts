// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/complexity/useOptionalChain: ported verbatim; explicit checks kept as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; constructor parameter properties as in the source.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/style/useErrorCause: ported verbatim; the message carries what the user needs and the original error is logged where it matters, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning interfaces and callbacks; kept as in the source.

import {
  blockTypeSummaries,
  propsForAgent,
  styleTokens,
} from "@repo/cms-core/agent/catalogue";
import type { AgentProviderId } from "@repo/cms-core/agent/models";
import { normalizeSlug, validatePlan } from "@repo/cms-core/agent/plan";
import { DEVICE_WIDTH, siteContext } from "@repo/cms-core/agent/prompt";
import {
  newRunItems,
  RUN_ID_PREFIX,
  type Run,
  type RunItem,
  recordProduced,
} from "@repo/cms-core/agent/run";
import { stageOps, stageSeo, withBareTitles } from "@repo/cms-core/agent/stage";
import {
  isToolName,
  parseToolInput,
  type ToolInput,
  type ToolName,
  toolLabel,
} from "@repo/cms-core/agent/tool-defs";
import type {
  AgentErrorCode,
  AgentToolError,
  Changeset,
  CreatedPage,
} from "@repo/cms-core/agent/types";
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { diffDocs } from "@repo/cms-core/editor/diff";
import type { PagePerformance, SeoGscOverview } from "@repo/cms-core/gsc/shape";
import { newPageDoc, newPostDoc } from "@repo/cms-core/new-docs";
import { runSeoChecks, seoScore } from "@repo/cms-core/seo/checks";
import {
  buildSeoOverview,
  type MediaSizes,
  otherPagesFrom,
  type SeoPageInput,
} from "@repo/cms-core/seo/overview";
import type {
  ShareOverrides,
  ShareTemplate,
} from "@repo/cms-core/share/params";
import type { SiteConfig } from "@repo/cms-core/site/config";
import type { SiteSeo } from "@repo/cms-core/site/types";
import type { Block, Device, PageDoc, PageKind } from "@repo/cms-core/types";
import type { MediaInfo } from "../cms/media-service";
import { CmsError } from "../cms/pages-service";
import type { PageMeta, PageRow } from "../cms/repo";
import { mutateRun } from "./runs";
import { type AgentStore, type ChangesetRow, toChangeset } from "./store-port";

/**
 * The agent's tools (docs/cms-plan.md §4.3). Read tools may look at any page; render and write
 * tools only act on the request's page: the thread's page, or in a site-wide run the item's page
 * (for create/duplicate items, the draft once it exists). A site-wide planning turn only reads and
 * calls `submit_plan`. Write tools only stage changesets in D1, except `create_page` and
 * `duplicate_page`, which create unpublished drafts: nothing here changes an existing draft,
 * publishes or deletes. Every input is parsed with the tool's Zod
 * schema first; a failure, like every other expected problem, goes back to the model as an
 * `is_error` result with a stable code.
 */

/** A stored image: a media-library id or an agent screenshot in R2. Expanded to base64 when sent to the API. */
export type ImageRef = {
  type: "image";
  source: { type: "ref"; ref: string; media_type: string };
};
export type StoredToolContent =
  | string
  | ({ type: "text"; text: string } | ImageRef)[];

export type ToolDeps = {
  store: AgentStore;
  pageBySlug(slug: string): Promise<PageRow | null>;
  pageById(id: string): Promise<PageRow | null>;
  /** The document of the page's live (published) revision, or null when it isn't live. */
  liveDoc(page: PageRow): Promise<PageDoc | null>;
  listPages(): Promise<PageMeta[]>;
  /** Every non-archived page with its draft (the SEO checks compare across pages). */
  draftPages(): Promise<SeoPageInput[]>;
  /** The deployment's name and origin (`siteConfig()` in cms-core): canonical URLs, internal links, the site facts. */
  config: SiteConfig;
  /** IANA zone for "today" (a duplicated post's date), default "UTC" (D14). */
  timeZone?: string;
  siteSeo(): Promise<SiteSeo>;
  mediaSizes(ids: string[]): Promise<MediaSizes>;
  searchMedia(query: string, limit: number): Promise<MediaInfo[]>;
  getMedia(id: string): Promise<MediaInfo | null>;
  pagePerformance(
    page: { id: string; slug: string },
    days: number
  ): Promise<PagePerformance>;
  gscOverview(): Promise<SeoGscOverview>;
  /** A JPEG of `doc` rendered at the device width. `target` is a changeset id or null (the saved draft). */
  renderPreview(input: {
    page: PageRow;
    changesetId: string | null;
    device: Device;
    focusKey?: string;
  }): Promise<Uint8Array>;
  shareImage(input: {
    pageId: string;
    template: ShareTemplate;
    overrides: ShareOverrides;
    alt?: string;
  }): Promise<MediaInfo>;
  /** An absolute, signed preview link to the page's draft, or to one of its pending changesets (1 hour; preview-link.ts). */
  previewLink(input: {
    page: PageRow;
    changesetId: string | null;
  }): Promise<{ url: string; expiresAt: string }>;
  /** Stores an agent screenshot; returns its ref ("r2:<key>"). */
  putScreenshot(threadId: string, bytes: Uint8Array): Promise<string>;
  /** Creates a draft page or post (pages-service `createPage`, after the slug checks). Throws `CmsError`. */
  createDraft(input: {
    kind: PageKind;
    slug: string;
    title: string;
    doc: PageDoc;
  }): Promise<PageRow>;
  now?: () => number;
  genId?: () => string;
};

/**
 * What the request may change. `page`: the thread's page. `plan`: a site-wide planning turn (read
 * tools and submit_plan only). `item`: one item of an approved run.
 */
export type ToolScope =
  | { kind: "page" }
  | { kind: "plan"; provider: AgentProviderId; model: string }
  | { kind: "item"; runId: string; item: RunItem };

export type ToolCtx = {
  threadId: string;
  /** The page render and write tools act on; null while a create/duplicate item has no draft yet, or while planning. */
  pageId: string | null;
  /** Renders and new drafts so far in this request (render_preview, render_share_image, create_page, duplicate_page). */
  counts: { preview: number; share: number; create: number };
  /** Missing = `page`. */
  scope?: ToolScope;
  /** What this request staged and created (the run item's outcome). */
  produced?: { changesetIds: string[]; createdPageIds: string[] };
};

export type ToolOutcome = {
  content: StoredToolContent;
  isError: boolean;
  /** One line for the chat's tool chip. */
  summary: string;
  label: string;
  changeset?: Changeset;
  /** A data URL of a rendered image, for the chat. */
  image?: string;
  /** `create_page`, `duplicate_page`: the new draft. */
  created?: CreatedPage;
  /** `submit_plan`: the proposed run. */
  plan?: Run;
};

export const MAX_RENDERS = 3;
export const MAX_CREATES = 3;

class ToolFailure extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly path?: string
  ) {
    super(message);
  }
}

const json = (v: unknown) => JSON.stringify(v);

function errorContent(errors: AgentToolError[]): string {
  return json({ ok: false, errors });
}

/** Runs one tool call. Never throws for expected problems; unexpected ones become RENDER_FAILED/INVALID_INPUT-style errors too. */
export async function runTool(
  deps: ToolDeps,
  ctx: ToolCtx,
  name: string,
  rawInput: unknown
): Promise<ToolOutcome> {
  const input = (
    typeof rawInput === "object" && rawInput !== null ? rawInput : {}
  ) as Record<string, unknown>;
  const label = toolLabel(name, input);
  if (!isToolName(name)) {
    return {
      content: errorContent([
        { code: "INVALID_INPUT", message: `No tool called "${name}"` },
      ]),
      isError: true,
      summary: "Unknown tool",
      label,
    };
  }
  const parsed = parseToolInput(name, rawInput);
  if (!parsed.ok) {
    return {
      content: errorContent([
        {
          code: "INVALID_INPUT",
          message: `Input doesn't match the ${name} schema: ${parsed.message}`,
        },
      ]),
      isError: true,
      summary: "Invalid input (asked to fix it)",
      label,
    };
  }
  try {
    const out = await HANDLERS[name](deps, ctx, parsed.input as never);
    return { label, ...out };
  } catch (err) {
    if (err instanceof ToolFailure) {
      return {
        content: errorContent([
          {
            code: err.code,
            message: err.message,
            ...(err.path && { path: err.path }),
          },
        ]),
        isError: true,
        summary: err.message,
        label,
      };
    }
    console.error(`agent tool ${name} failed`, err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: errorContent([
        { code: "RENDER_FAILED", message: `The tool failed: ${message}` },
      ]),
      isError: true,
      summary: `Failed: ${message}`,
      label,
    };
  }
}

type Handler<N extends ToolName> = (
  deps: ToolDeps,
  ctx: ToolCtx,
  input: ToolInput<N>
) => Promise<Omit<ToolOutcome, "label">>;

const ok = (data: unknown, summary: string): Omit<ToolOutcome, "label"> => ({
  content: json(data),
  isError: false,
  summary,
});

async function requirePage(
  deps: ToolDeps,
  slug: string
): Promise<PageRow & { draftDoc: PageDoc }> {
  const page = await deps.pageBySlug(slug);
  if (!(page && page.draftDoc)) {
    throw new ToolFailure(
      "NOT_FOUND",
      `No page with slug "${slug}" (see list_pages)`
    );
  }
  return page as PageRow & { draftDoc: PageDoc };
}

/** Today as YYYY-MM-DD in `timeZone`. */
function todayIn(timeZone: string, now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(now));
}

const PLANNING =
  "This is a site-wide conversation: plan first. Read what you need, then call submit_plan; pages are changed one at a time after the user approves the plan.";

/** Render and write tools act only on the request's page (the thread's, or the run item's). */
async function requireThreadPage(deps: ToolDeps, ctx: ToolCtx, slug: string) {
  const scope = ctx.scope ?? { kind: "page" };
  if (scope.kind === "plan") {
    throw new ToolFailure("NOT_ALLOWED", PLANNING);
  }
  const page = await requirePage(deps, slug);
  if (scope.kind === "item" && !ctx.pageId) {
    const how =
      scope.item.action === "duplicate"
        ? `duplicate_page from "${scope.item.from}" to "${scope.item.slug}"`
        : `create_page at "${scope.item.slug}"`;
    throw new ToolFailure(
      "NOT_ALLOWED",
      `This run item creates its page first: call ${how}, then change the new draft.`
    );
  }
  if (page.id !== ctx.pageId) {
    throw new ToolFailure(
      "WRONG_PAGE",
      scope.kind === "item"
        ? `This run item is about /${scope.item.slug} only. Read other pages, but propose changes for /${scope.item.slug} only.`
        : "This conversation can only change the page it was opened on. Read other pages, but propose changes for this page only."
    );
  }
  if (page.status === "archived") {
    throw new ToolFailure("NOT_ALLOWED", "The page is archived.");
  }
  return page;
}

/** The block's main text for outlines. */
function blockGist(block: Block): string {
  const p = (block.props ?? {}) as Record<string, unknown>;
  for (const k of [
    "heading",
    "title",
    "eyebrow",
    "q",
    "body",
    "lead",
    "caption",
    "alt",
  ]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) {
      return v.trim().slice(0, 140);
    }
  }
  const plain = JSON.stringify(p).match(/"text":"([^"]{3,140})/);
  return plain ? plain[1]! : "";
}

function outline(page: PageRow & { draftDoc: PageDoc }) {
  const doc = page.draftDoc;
  return {
    slug: doc.seo.slug,
    title: page.title,
    kind: page.kind,
    status: page.status,
    draftVersion: page.draftVersion,
    seo: {
      title: doc.seo.title,
      description: doc.seo.description,
      focusKeyphrase: doc.seo.focusKeyphrase ?? null,
    },
    ...(doc.post && {
      post: {
        title: doc.post.title,
        excerpt: doc.post.excerpt,
        category: doc.post.category,
        tags: doc.post.tags,
      },
    }),
    blocks: doc.blocks.map((b) => {
      const props = (b.props ?? {}) as Record<string, unknown>;
      const counts = Object.fromEntries(
        Object.entries(props)
          .filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => [k, (v as unknown[]).length])
      );
      const hidden = b.style?.hide
        ? Object.entries(b.style.hide)
            .filter(([, v]) => v)
            .map(([d]) => d)
        : [];
      return {
        key: b._key,
        type: b._type,
        label: getBlockDef(b._type)?.label ?? b._type,
        text: blockGist(b),
        ...(Object.keys(counts).length && { items: counts }),
        ...(hidden.length && { hiddenOn: hidden }),
        ...(b.style && { styled: Object.keys(b.style) }),
      };
    }),
  };
}

function fullBlock(block: Block) {
  const def = getBlockDef(block._type);
  return {
    key: block._key,
    type: block._type,
    props: def ? propsForAgent(def, block.props) : block.props,
    ...(block.style && { style: block.style }),
  };
}

async function seoContextFor(
  deps: ToolDeps,
  page: PageRow & { draftDoc: PageDoc }
) {
  const [all, site] = await Promise.all([deps.draftPages(), deps.siteSeo()]);
  const ids = page.draftDoc.seo.social.image
    ? [page.draftDoc.seo.social.image.mediaId]
    : [];
  const media = await deps.mediaSizes(ids);
  return {
    others: otherPagesFrom(
      all.filter((p) => p.id !== page.id),
      deps.config,
      site
    ),
    media,
    site,
    all,
  };
}

/** What changed, for the model's confirmation (block → fields). */
function changeList(base: PageDoc, doc: PageDoc) {
  const diff = diffDocs(base, doc);
  return {
    blocks: diff.blocks.map((b) => ({
      key: b.key,
      type: b.type,
      status: b.status,
      ...(b.status === "changed" && {
        fields: b.fields.map((f) => f.path || "(block)").slice(0, 20),
      }),
    })),
    ...(diff.post.length && { post: diff.post.map((f) => f.path) }),
    ...(diff.seo.length && { seo: diff.seo.map((f) => f.path) }),
  };
}

function newChangeset(
  deps: ToolDeps,
  ctx: ToolCtx,
  page: PageRow,
  kind: "ops" | "seo",
  summary: string,
  payload: ChangesetRow["payload"],
  base: PageDoc,
  proposed: PageDoc,
  warnings: unknown
): ChangesetRow {
  return {
    id: deps.genId?.() ?? crypto.randomUUID(),
    threadId: ctx.threadId,
    pageId: page.id,
    kind,
    summary,
    status: "pending",
    payload,
    baseDoc: base,
    proposedDoc: proposed,
    warnings,
    decision: null,
    createdAt: new Date(deps.now?.() ?? Date.now()),
    decidedAt: null,
  };
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x80_00) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));
  }
  return btoa(s);
};

/** Where create_page / duplicate_page may create a draft: anywhere in a page thread; in a run, only the item's own new page, once. */
function checkNewDraft(
  ctx: ToolCtx,
  action: "create" | "duplicate",
  slug: string,
  from?: string
) {
  const scope = ctx.scope ?? { kind: "page" };
  if (scope.kind === "plan") {
    throw new ToolFailure("NOT_ALLOWED", PLANNING);
  }
  if (scope.kind !== "item") {
    return;
  }
  const item = scope.item;
  if (item.action !== action) {
    throw new ToolFailure(
      "NOT_ALLOWED",
      item.action === "create" || item.action === "duplicate"
        ? `This item's draft is made with ${item.action === "create" ? "create_page" : "duplicate_page"}.`
        : `This item changes the existing page /${item.slug}; use propose_ops or propose_seo.`
    );
  }
  if (ctx.pageId) {
    throw new ToolFailure(
      "NOT_ALLOWED",
      `The draft for /${item.slug} already exists; change it with propose_ops.`
    );
  }
  if (normalizeSlug(slug) !== item.slug) {
    throw new ToolFailure(
      "WRONG_PAGE",
      `This run item creates /${item.slug}; use that slug.`,
      action === "duplicate" ? "to" : "slug"
    );
  }
  if (from !== undefined && from !== item.from) {
    throw new ToolFailure(
      "WRONG_PAGE",
      `This run item copies /${item.from}.`,
      "from"
    );
  }
}

/**
 * What a write tool staged or created: added to the request's outcome (`produced`) and, in a run
 * item, recorded on the run at once, so it survives a turn that then throws (or a Worker that
 * dies before the turn's end is recorded).
 */
async function recordOutput(
  deps: ToolDeps,
  ctx: ToolCtx,
  p: { changesetId?: string; createdPageId?: string }
) {
  if (p.changesetId) {
    ctx.produced?.changesetIds.push(p.changesetId);
  }
  if (p.createdPageId) {
    ctx.produced?.createdPageIds.push(p.createdPageId);
  }
  const scope = ctx.scope;
  if (scope?.kind === "item") {
    await mutateRun(deps.store, scope.runId, (r) =>
      recordProduced(r, scope.item.id, p)
    );
  }
}

/** A new draft becomes the request's page (in a run item) and is recorded as produced. */
async function draftCreated(
  deps: ToolDeps,
  ctx: ToolCtx,
  page: PageRow
): Promise<CreatedPage> {
  if (ctx.scope?.kind === "item") {
    ctx.pageId = page.id;
  }
  await recordOutput(deps, ctx, { createdPageId: page.id });
  return {
    id: page.id,
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    editorUrl: `/admin/editor/${page.id}`,
  };
}

/**
 * In a run item whose slug is taken: the draft an earlier attempt of this item created, if that
 * is what is there (the item's recorded draft, or an untouched draft made after the run was
 * approved, from an attempt that died before recording it). Becomes the item's page instead of a
 * dead end on SLUG_TAKEN.
 */
async function earlierDraft(
  deps: ToolDeps,
  ctx: ToolCtx,
  slug: string
): Promise<PageRow | null> {
  const scope = ctx.scope;
  if (scope?.kind !== "item") {
    return null;
  }
  const page = await deps.pageBySlug(slug);
  if (!page || page.status !== "draft") {
    return null;
  }
  const run = await deps.store.getRun(scope.runId);
  const item = run?.items.find((i) => i.id === scope.item.id);
  if (item?.createdPageId === page.id) {
    return page;
  }
  if (
    run?.approvedAt &&
    page.draftVersion === 0 &&
    page.updatedAt.getTime() >= Date.parse(run.approvedAt)
  ) {
    return page;
  }
  return null;
}

async function reuseDraft(
  deps: ToolDeps,
  ctx: ToolCtx,
  page: PageRow
): Promise<Omit<ToolOutcome, "label">> {
  const created = await draftCreated(deps, ctx, page);
  return {
    content: json({
      ok: true,
      id: page.id,
      slug: page.slug,
      title: page.title,
      status: "draft (not published)",
      reused:
        "An earlier attempt at this item already created this draft; it is this item's page now. Change it with propose_ops instead of creating it again.",
      editorUrl: created.editorUrl,
    }),
    isError: false,
    summary: `Continuing on the draft /${page.slug}`,
    created,
  };
}

/**
 * A draft copy at `slug`, so it can't go live as a twin of the original by accident: same blocks
 * and styles, the share image and canonical (they belong to the original) dropped, the SEO title
 * prefixed "Copy of", and search engines told not to index it until someone turns indexing back on
 * in the SEO panel.
 */
export function duplicateDoc(
  source: PageDoc,
  slug: string,
  title: string,
  today: string
): PageDoc {
  const doc = structuredClone(source);
  const { image: _image, ...social } = doc.seo.social;
  const { canonical: _canonical, ...seo } = doc.seo;
  return {
    ...doc,
    seo: {
      ...seo,
      slug,
      social,
      title: `Copy of ${seo.title}`.slice(0, 200),
      robots: { ...seo.robots, index: false },
    },
    ...(doc.post && {
      post: {
        ...doc.post,
        title,
        publishedAt: today,
        publishedAtAuto: true as const,
        modifiedAt: undefined,
      },
    }),
  };
}

const HANDLERS: { [N in ToolName]: Handler<N> } = {
  async list_pages(deps, _ctx, input) {
    const pages = (await deps.listPages()).filter(
      (p) => p.status !== "archived" && (!input.kind || p.kind === input.kind)
    );
    return ok(
      pages.map((p) => ({
        slug: p.slug,
        title: p.title,
        kind: p.kind,
        status: p.status,
      })),
      `${pages.length} pages`
    );
  },

  async get_page(deps, _ctx, input) {
    const page = await requirePage(deps, input.slug);
    if (input.mode === "outline") {
      return ok(outline(page), `${page.draftDoc.blocks.length} blocks`);
    }
    const doc = page.draftDoc;
    return ok(
      {
        ...outline(page),
        seo: doc.seo,
        // The <title> is this template around seo.title unless seo.titleExact.
        titleTemplate: (await deps.siteSeo()).titleTemplate,
        ...(doc.post && { post: doc.post }),
        blocks: doc.blocks.map(fullBlock),
      },
      `${doc.blocks.length} blocks in full`
    );
  },

  async get_block(deps, _ctx, input) {
    const page = await requirePage(deps, input.slug);
    const block = page.draftDoc.blocks.find((b) => b._key === input.key);
    if (!block) {
      throw new ToolFailure(
        "UNKNOWN_KEY",
        `No block "${input.key}" on this page (keys: ${page.draftDoc.blocks.map((b) => b._key).join(", ")})`
      );
    }
    return ok(fullBlock(block), getBlockDef(block._type)?.label ?? block._type);
  },

  async list_block_types() {
    const types = blockTypeSummaries();
    return ok(types, `${types.length} block types`);
  },

  async list_style_tokens() {
    return ok(styleTokens(), "Brand tokens and scales");
  },

  async search_media(deps, _ctx, input) {
    const items = await deps.searchMedia(input.query, input.limit ?? 12);
    return ok(
      items.map((m) => ({
        mediaId: m.id,
        alt: m.alt,
        tags: m.tags,
        width: m.width,
        height: m.height,
        mime: m.mime,
      })),
      `${items.length} images`
    );
  },

  async get_site_context(deps) {
    return ok({ facts: siteContext(deps.config) }, "Site facts");
  },

  async audit_seo(deps, _ctx, input) {
    if (input.slug === "all") {
      const [all, site] = await Promise.all([
        deps.draftPages(),
        deps.siteSeo(),
      ]);
      const ids = all.flatMap((p) =>
        p.doc.seo.social.image ? [p.doc.seo.social.image.mediaId] : []
      );
      const rows = buildSeoOverview(
        all,
        await deps.mediaSizes(ids),
        deps.config,
        site
      );
      return ok(
        rows.map((r) => ({
          slug: r.slug,
          title: r.seoTitle,
          score: r.score,
          issues: r.issues.map((i) => `${i.status}: ${i.label} — ${i.message}`),
        })),
        `${rows.length} pages audited`
      );
    }
    const page = await requirePage(deps, input.slug);
    const { others, media, site } = await seoContextFor(deps, page);
    const checks = runSeoChecks(page.draftDoc, {
      config: deps.config,
      pageId: page.id,
      others,
      media,
      kind: page.kind,
      isHome: page.slug === "",
      site,
    });
    const order = { fail: 0, warn: 1, info: 2, pass: 3, na: 4 } as const;
    return ok(
      {
        score: seoScore(checks),
        checks: [...checks]
          .sort((a, b) => order[a.status] - order[b.status])
          .map((c) => ({
            id: c.id,
            status: c.status,
            label: c.label,
            message: c.message,
          })),
      },
      `Score ${seoScore(checks)}`
    );
  },

  async get_seo_overview(deps) {
    const [all, site, gsc] = await Promise.all([
      deps.draftPages(),
      deps.siteSeo(),
      deps.gscOverview(),
    ]);
    const ids = all.flatMap((p) =>
      p.doc.seo.social.image ? [p.doc.seo.social.image.mediaId] : []
    );
    const rows = buildSeoOverview(
      all,
      await deps.mediaSizes(ids),
      deps.config,
      site
    );
    return ok(
      {
        gscRange: gsc.range,
        pages: rows.map((r) => ({
          slug: r.slug,
          kind: r.kind,
          status: r.status,
          title: r.seoTitle,
          description: r.description,
          focusKeyphrase:
            all.find((p) => p.id === r.id)?.doc.seo.focusKeyphrase ?? null,
          score: r.score,
          fails: r.fails,
          warns: r.warns,
          gsc28d: gsc.byPageId[r.id] ?? null,
        })),
      },
      `${rows.length} pages`
    );
  },

  async get_search_performance(deps, _ctx, input) {
    const page = await requirePage(deps, input.slug);
    const perf = await deps.pagePerformance(
      { id: page.id, slug: page.slug },
      input.days
    );
    if (!perf.range) {
      return ok(
        {
          url: perf.url,
          data: null,
          note: "No Search Console data yet for this site.",
          inspection: perf.inspection,
        },
        "No Search Console data"
      );
    }
    return ok(
      {
        url: perf.url,
        range: perf.range,
        totals: perf.totals,
        topQueries: perf.topQueries.map((q) => ({
          query: q.query,
          clicks: q.clicks,
          impressions: q.impressions,
          position: Math.round(q.position * 10) / 10,
        })),
        publishes: perf.markers.map((m) => ({
          date: m.date,
          label: m.labels?.[0] ?? null,
        })),
        inspection: perf.inspection && {
          verdict: perf.inspection.verdict,
          coverageState: perf.inspection.coverageState,
          lastCrawl: perf.inspection.lastCrawl,
        },
      },
      `${perf.totals.clicks} clicks, ${perf.totals.impressions} impressions, ${perf.topQueries.length} queries`
    );
  },

  async find_seo_opportunities(deps, _ctx, input) {
    const gsc = await deps.gscOverview();
    let striking = gsc.striking;
    let notIndexed = gsc.notIndexed;
    if (input.slug !== undefined) {
      const page = await requirePage(deps, input.slug);
      striking = striking.filter((s) => s.pageId === page.id);
      notIndexed = notIndexed.filter((n) => n.pageId === page.id);
    }
    return ok(
      {
        range: gsc.range,
        minImpressions: gsc.minImpressions,
        striking: striking.slice(0, 20).map((s) => ({
          url: s.page,
          impressions: s.impressions,
          queries: s.queries.slice(0, 15).map((q) => ({
            query: q.query,
            impressions: q.impressions,
            clicks: q.clicks,
            position: Math.round(q.position * 10) / 10,
          })),
        })),
        notIndexed: notIndexed.map((n) => ({
          url: n.url,
          title: n.title,
          pending: n.pending,
          verdict: n.inspection?.verdict ?? "never inspected",
          coverage: n.inspection?.coverageState ?? null,
        })),
      },
      `${striking.length} striking-distance pages, ${notIndexed.length} not indexed`
    );
  },

  async render_preview(deps, ctx, input) {
    const page = await requireThreadPage(deps, ctx, input.slug);
    if (ctx.counts.preview >= MAX_RENDERS) {
      throw new ToolFailure(
        "LIMIT_REACHED",
        `At most ${MAX_RENDERS} previews per request.`
      );
    }
    let changesetId: string | null = null;
    if (input.changeset !== "none") {
      const pending = (await deps.store.changesets(ctx.threadId)).filter(
        (c) =>
          c.kind === "ops" && c.pageId === page.id && c.status === "pending"
      );
      changesetId = pending.at(-1)?.id ?? null;
    }
    const doc = changesetId
      ? (await deps.store.getChangeset(changesetId))!.proposedDoc
      : page.draftDoc;
    if (
      input.focus_key &&
      !doc.blocks.some((b) => b._key === input.focus_key)
    ) {
      throw new ToolFailure(
        "UNKNOWN_KEY",
        `No block "${input.focus_key}" on the rendered page`
      );
    }
    ctx.counts.preview++;
    const bytes = await deps.renderPreview({
      page,
      changesetId,
      device: input.device,
      focusKey: input.focus_key,
    });
    const ref = await deps.putScreenshot(ctx.threadId, bytes);
    const what = changesetId
      ? "the draft with your pending changeset"
      : "the saved draft";
    return {
      content: [
        {
          type: "text",
          text: `Rendered ${what} at ${input.device} width${input.focus_key ? `, cropped to block "${input.focus_key}"` : ""}.`,
        },
        {
          type: "image",
          source: { type: "ref", ref, media_type: "image/jpeg" },
        },
      ],
      isError: false,
      summary: `${input.device} preview of ${changesetId ? "your changes" : "the draft"}`,
      image: `data:image/jpeg;base64,${toBase64(bytes)}`,
    };
  },

  async get_preview_url(deps, _ctx, input) {
    const page = await requirePage(deps, input.slug);
    let changesetId: string | null = null;
    if (input.changeset === "latest") {
      changesetId =
        (await deps.store.pendingChangesets(page.id))[0]?.id ?? null;
      if (!changesetId) {
        throw new ToolFailure(
          "NOT_FOUND",
          `No pending proposal for /${page.slug}; use changeset "none" for the draft.`,
          "changeset"
        );
      }
    } else if (input.changeset !== undefined && input.changeset !== "none") {
      const cs = await deps.store.getChangeset(input.changeset);
      if (!cs || cs.pageId !== page.id) {
        throw new ToolFailure(
          "NOT_FOUND",
          `No proposal "${input.changeset}" for /${page.slug}`,
          "changeset"
        );
      }
      if (cs.status !== "pending") {
        throw new ToolFailure(
          "NOT_ALLOWED",
          `That proposal was ${cs.status}; only pending ones can be previewed.`,
          "changeset"
        );
      }
      changesetId = cs.id;
    }
    const link = await deps.previewLink({ page, changesetId });
    return ok(
      {
        url: link.url,
        expiresAt: link.expiresAt,
        renders: changesetId ? `changeset ${changesetId}` : "draft",
        ...(input.device && { viewportWidth: DEVICE_WIDTH[input.device] }),
      },
      changesetId ? "Preview link to a proposal" : "Preview link to the draft"
    );
  },

  async propose_ops(deps, ctx, input) {
    const page = await requireThreadPage(deps, ctx, input.slug);
    const base = page.draftDoc;
    const staged = stageOps(base, input.ops);
    if (!staged.ok) {
      return {
        content: errorContent(staged.errors),
        isError: true,
        summary: `${staged.errors[0]!.code}: ${staged.errors[0]!.message}`,
      };
    }
    await deps.store.supersede(ctx.threadId, page.id, "ops");
    const row = newChangeset(
      deps,
      ctx,
      page,
      "ops",
      input.summary,
      { ops: staged.ops },
      base,
      staged.doc,
      staged.warnings
    );
    await deps.store.insertChangeset(row);
    await recordOutput(deps, ctx, { changesetId: row.id });
    const changeset = toChangeset(row);
    return {
      content: json({
        ok: true,
        changesetId: row.id,
        status: "staged for review (not saved yet)",
        changes: changeList(base, staged.doc),
        ...(staged.warnings.length && { warnings: staged.warnings }),
      }),
      isError: false,
      summary: `Staged ${staged.ops.length} op${staged.ops.length === 1 ? "" : "s"}${staged.warnings.length ? ` · ${staged.warnings.length} warning(s)` : ""}`,
      changeset,
    };
  },

  async propose_seo(deps, ctx, input) {
    const page = await requireThreadPage(deps, ctx, input.slug);
    const image = input.seo.social?.image;
    if (image) {
      const media = await deps.getMedia(image.mediaId);
      if (!media) {
        throw new ToolFailure(
          "NOT_FOUND",
          `No media "${image.mediaId}"; use the mediaId render_share_image returned`,
          "seo.social.image.mediaId"
        );
      }
      image.width ??= media.width ?? undefined;
      image.height ??= media.height ?? undefined;
    }
    const site = await deps.siteSeo();
    const { proposal, stripped } = withBareTitles(
      {
        seo: input.seo,
        variants: input.variants,
        ...(input.rationale && { rationale: input.rationale }),
      },
      site.titleTemplate,
      page.draftDoc.seo.titleExact
    );
    const staged = stageSeo(page.draftDoc, proposal);
    if (!staged.ok) {
      return {
        content: errorContent(staged.errors),
        isError: true,
        summary: `${staged.errors[0]!.code}: ${staged.errors[0]!.message}`,
      };
    }
    await deps.store.supersede(ctx.threadId, page.id, "seo");
    const summary = `SEO: ${input.seo.focusKeyphrase ? `“${input.seo.focusKeyphrase}”, ` : ""}${input.variants.length} title options`;
    const row = newChangeset(
      deps,
      ctx,
      page,
      "seo",
      summary,
      proposal,
      page.draftDoc,
      staged.doc,
      []
    );
    await deps.store.insertChangeset(row);
    await recordOutput(deps, ctx, { changesetId: row.id });
    return {
      content: json({
        ok: true,
        changesetId: row.id,
        status: "staged for review: the user picks a variant in the SEO tab",
        ...(stripped > 0 && {
          note: `Removed the title template's text from ${stripped} title(s): the site already wraps titles as "${site.titleTemplate}". Write bare titles.`,
        }),
      }),
      isError: false,
      summary,
      changeset: toChangeset(row),
    };
  },

  async create_page(deps, ctx, input) {
    checkNewDraft(ctx, "create", input.slug);
    if (ctx.counts.create >= MAX_CREATES) {
      throw new ToolFailure(
        "LIMIT_REACHED",
        `At most ${MAX_CREATES} new drafts per request.`
      );
    }
    if (input.kind === "page" && input.post) {
      throw new ToolFailure(
        "INVALID_INPUT",
        "post details are only for posts",
        "post"
      );
    }
    let doc: PageDoc;
    if (input.kind === "post") {
      // Category and author default to the latest post's, as the "New post" dialog does.
      const latest = (await deps.draftPages())
        .flatMap((p) => (p.kind === "post" && p.doc.post ? [p.doc.post] : []))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
      const category = input.post?.category ?? latest?.category;
      const author = input.post?.author ?? latest?.author;
      if (!category) {
        throw new ToolFailure(
          "INVALID_INPUT",
          "A post needs post.category (there is no earlier post to take it from)",
          "post.category"
        );
      }
      if (!author) {
        throw new ToolFailure(
          "INVALID_INPUT",
          "A post needs post.author (there is no earlier post to take it from)",
          "post.author"
        );
      }
      doc = newPostDoc({
        title: input.title,
        slug: input.slug,
        category,
        author,
      });
      doc = {
        ...doc,
        post: {
          ...doc.post!,
          ...(input.post?.excerpt !== undefined && {
            excerpt: input.post.excerpt,
          }),
          ...(input.post?.tags && { tags: input.post.tags }),
        },
      };
    } else {
      doc = newPageDoc(input.title, input.slug);
    }
    if (input.blocks) {
      const staged = stageOps(
        { ...doc, blocks: [] },
        input.blocks.map((block) => ({ op: "insert", block }))
      );
      if (!staged.ok) {
        const errors = staged.errors.map((e) => ({
          ...e,
          ...(e.path && {
            path: e.path.replace(/^ops\[(\d+)\](\.block)?/, "blocks[$1]"),
          }),
        }));
        return {
          content: errorContent(errors),
          isError: true,
          summary: `${errors[0]!.code}: ${errors[0]!.message}`,
        };
      }
      doc = staged.doc;
    }
    ctx.counts.create++;
    let page: PageRow;
    try {
      page = await deps.createDraft({
        kind: input.kind,
        slug: input.slug,
        title: input.title,
        doc,
      });
    } catch (err) {
      if (!(err instanceof CmsError)) {
        throw err;
      }
      const earlier =
        err.code === "SLUG_TAKEN"
          ? await earlierDraft(deps, ctx, normalizeSlug(input.slug))
          : null;
      if (earlier) {
        return reuseDraft(deps, ctx, earlier);
      }
      const code: AgentErrorCode =
        err.code === "SLUG_TAKEN" ||
        err.code === "SLUG_RESERVED" ||
        err.code === "INVALID_SLUG"
          ? err.code
          : err.code === "BAD_KIND"
            ? "INVALID_INPUT"
            : "INVALID_PROPS";
      throw new ToolFailure(
        code,
        err.message,
        code === "INVALID_PROPS" ? undefined : "slug"
      );
    }
    const created = await draftCreated(deps, ctx, page);
    return {
      content: json({
        ok: true,
        id: page.id,
        slug: page.slug,
        title: page.title,
        status: "draft (not published)",
        editorUrl: created.editorUrl,
        blocks: doc.blocks.length,
      }),
      isError: false,
      summary: `Draft ${input.kind} /${page.slug}`,
      created,
    };
  },

  async duplicate_page(deps, ctx, input) {
    const to = normalizeSlug(input.to);
    const fromSlug = normalizeSlug(input.from);
    checkNewDraft(ctx, "duplicate", to, fromSlug);
    if (ctx.counts.create >= MAX_CREATES) {
      throw new ToolFailure(
        "LIMIT_REACHED",
        `At most ${MAX_CREATES} new drafts per request.`
      );
    }
    const source = await requirePage(deps, fromSlug);
    if (source.status === "archived") {
      throw new ToolFailure("NOT_FOUND", `/${fromSlug} is archived`, "from");
    }
    const title =
      input.title?.trim() || `Copy of ${source.title}`.slice(0, 200);
    // A published page is copied as visitors see it (the live version), not with its unpublished draft edits.
    const live =
      source.status === "published" ? await deps.liveDoc(source) : null;
    const doc = duplicateDoc(
      live ?? source.draftDoc,
      to,
      title,
      todayIn(deps.timeZone ?? "UTC", (deps.now ?? Date.now)())
    );
    ctx.counts.create++;
    let page: PageRow;
    try {
      page = await deps.createDraft({
        kind: source.kind,
        slug: to,
        title,
        doc,
      });
    } catch (err) {
      if (!(err instanceof CmsError)) {
        throw err;
      }
      const earlier =
        err.code === "SLUG_TAKEN" ? await earlierDraft(deps, ctx, to) : null;
      if (earlier) {
        return reuseDraft(deps, ctx, earlier);
      }
      const code: AgentErrorCode =
        err.code === "SLUG_TAKEN" ||
        err.code === "SLUG_RESERVED" ||
        err.code === "INVALID_SLUG"
          ? err.code
          : err.code === "BAD_KIND"
            ? "INVALID_SLUG"
            : "INVALID_PROPS";
      throw new ToolFailure(
        code,
        err.message,
        code === "INVALID_PROPS" ? undefined : "to"
      );
    }
    const created = await draftCreated(deps, ctx, page);
    return {
      content: json({
        ok: true,
        id: page.id,
        slug: page.slug,
        title: page.title,
        copiedFrom: source.slug,
        copiedVersion: live ? "live (published)" : "draft",
        status: "draft (not published)",
        seo: `Not indexed by search engines and titled "${doc.seo.title}" until changed: propose_seo a real title and description; the user turns indexing on in the SEO panel when it's ready.`,
        editorUrl: created.editorUrl,
        blocks: doc.blocks.length,
      }),
      isError: false,
      summary: `Draft copy /${page.slug} of /${source.slug}`,
      created,
    };
  },

  async submit_plan(deps, ctx, input) {
    const scope = ctx.scope ?? { kind: "page" };
    if (scope.kind !== "plan") {
      throw new ToolFailure(
        "NOT_ALLOWED",
        scope.kind === "item"
          ? "You are running one item of an approved plan; work on this page only."
          : "Plans are for site-wide conversations. The user can start one with the Site switch in the AI tab; here, work on this page."
      );
    }
    const pages = (await deps.listPages()).map((p) => ({
      slug: p.slug,
      kind: p.kind,
      status: p.status,
    }));
    const checked = validatePlan(input.items, pages);
    if (!checked.ok) {
      const errors = checked.errors.map((e) => ({
        code: e.code,
        message: e.message,
        path: e.path,
      }));
      return {
        content: errorContent(errors),
        isError: true,
        summary: `${errors.length} problem(s) in the plan: ${errors[0]!.message}`,
      };
    }
    const now = new Date(deps.now?.() ?? Date.now()).toISOString();
    // An unapproved earlier plan in this conversation is replaced.
    for (const old of await deps.store.listRuns({ threadId: ctx.threadId })) {
      if (old.status === "proposed") {
        await deps.store.saveRun({
          ...old,
          status: "superseded",
          updatedAt: now,
        });
      }
    }
    const gen = deps.genId ?? (() => crypto.randomUUID());
    const run: Run = {
      id: `${RUN_ID_PREFIX}${gen()}`,
      threadId: ctx.threadId,
      status: "proposed",
      summary: input.summary.trim(),
      items: newRunItems(checked.items, gen),
      costUsd: 0,
      provider: scope.provider,
      model: scope.model,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      revertedAt: null,
      revertedBy: null,
      version: 0,
    };
    await deps.store.createRun(run);
    return {
      content: json({
        ok: true,
        runId: run.id,
        status:
          "proposed: the user edits and approves the plan; nothing has changed yet",
        items: run.items.map((i) => ({ slug: i.slug, action: i.action })),
        next: "Stop now. Summarise the plan in one or two sentences; don't start on the pages.",
      }),
      isError: false,
      summary: `Plan: ${run.items.length} page${run.items.length === 1 ? "" : "s"}`,
      plan: run,
    };
  },

  async render_share_image(deps, ctx, input) {
    const page = await requireThreadPage(deps, ctx, input.slug);
    if (ctx.counts.share >= MAX_RENDERS) {
      throw new ToolFailure(
        "LIMIT_REACHED",
        `At most ${MAX_RENDERS} share images per request.`
      );
    }
    if (input.bg && !(await deps.getMedia(input.bg))) {
      throw new ToolFailure(
        "NOT_FOUND",
        `No media "${input.bg}" (see search_media)`,
        "bg"
      );
    }
    ctx.counts.share++;
    const overrides: ShareOverrides = {};
    for (const k of [
      "eyebrow",
      "headline",
      "category",
      "author",
      "bg",
      "gradient",
    ] as const) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) {
        (overrides as Record<string, string>)[k] = v.trim();
      }
    }
    const media = await deps.shareImage({
      pageId: page.id,
      template: input.template,
      overrides,
      alt: input.alt,
    });
    return {
      content: [
        {
          type: "text",
          text: json({
            mediaId: media.id,
            alt: media.alt,
            width: media.width,
            height: media.height,
            note: "Stored in the media library. Pass these to propose_seo as seo.social.image if it reads well.",
          }),
        },
        {
          type: "image",
          source: {
            type: "ref",
            ref: `media:${media.id}`,
            media_type: media.mime,
          },
        },
      ],
      isError: false,
      summary: `${input.template} share image`,
      image: media.url,
    };
  },
};
