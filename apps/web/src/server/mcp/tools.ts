// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (the image stream is read chunk by chunk), as in the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; the error class keeps the source's parameter properties.
// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim; method signatures as in the source (kept diffable).
// biome-ignore-all lint/style/useDestructuring: ported verbatim (kept diffable).
// biome-ignore-all lint/style/useErrorCause: the caught parse error carries nothing the tool error doesn't already say.
import { conflicts } from "@repo/cms-core/agent/changeset";
import { parseItemThread, RunError } from "@repo/cms-core/agent/run";
import { stageOps } from "@repo/cms-core/agent/stage";
import {
  DESCRIPTIONS,
  TOOL_INPUTS,
  type ToolName,
} from "@repo/cms-core/agent/tool-defs";
import type { SeoProposal } from "@repo/cms-core/agent/types";
import { diffDocs, type FieldChange, textOf } from "@repo/cms-core/editor/diff";
import { newPostDoc } from "@repo/cms-core/new-docs";
import { slugToPath } from "@repo/cms-core/paths";
import type { Op, PageDoc } from "@repo/cms-core/types";
import {
  acceptChangeset,
  rejectChangeset,
  reviewRunItem,
} from "@repo/services/agent/runs";
import type {
  AgentStore,
  PendingChangeset,
} from "@repo/services/agent/store-port";
import {
  runTool,
  type ToolCtx,
  type ToolDeps,
} from "@repo/services/agent/tools";
import { MAX_MEDIA_BYTES } from "@repo/services/cms/media-bytes";
import {
  type MediaDeps,
  MediaError,
  updateMediaAlt,
  uploadMedia,
} from "@repo/services/cms/media-service";
import {
  applyDraftOps,
  archivePage,
  CmsError,
  checkSlugAvailable,
  createPage,
  getPage,
  listPages,
  type PublishResult,
  pageRevision,
  publish,
  republish,
  restore,
  revisionHistory,
  rollbackLive,
  type ServiceDeps,
  saveVersion,
  unarchivePage,
  unpublish,
} from "@repo/services/cms/pages-service";
import type { PageRow } from "@repo/services/cms/repo";
import {
  getSiteState,
  publishSite,
  type SiteDeps,
  saveSiteDraft,
} from "@repo/services/cms/site-service";
import { mcpAuthor } from "@repo/services/mcp/author";
import type { McpIdentity } from "@repo/services/mcp/keys";
import { type ApiScope, scopeAllows } from "@repo/services/mcp/scopes";
import { z } from "zod";

/**
 * The MCP server's tools. Most reuse the built-in agent's
 * tools through `runTool` (same Zod schemas and descriptions); the rest call the page, site and
 * media services directly. Every tool has a scope; `callMcpTool` refuses a tool the key's scope
 * doesn't cover (a tool error naming the scope it needs), parses the input, runs the tool, maps
 * expected failures to `{ ok: false, code, message }` tool errors and logs the call.
 *
 * Tools of their own take a page as `id` or `slug` (exactly one; archived pages only by id). The
 * agent tools take `slug`, as in the editor's AI tab. Takes its dependencies as arguments, so tests
 * run it on the in-memory repos.
 */

export type McpDeps = {
  key: McpIdentity;
  /** The site's origin, for absolute links. An http origin (local dev) also lets `upload_media` fetch http URLs. */
  origin: string;
  /** The built-in agent's tools, wired as for the AI tab (adapters/tool-deps.ts). */
  tools: ToolDeps;
  store: AgentStore;
  /** Page service with `author: "mcp:<key name>#<key prefix>"` (`"mcp:<connection name>"` over OAuth). */
  cms: ServiceDeps;
  site: SiteDeps;
  media: MediaDeps;
  /** Writes one `mcp_calls` row. */
  log(call: {
    tool: string;
    target: string | null;
    ok: boolean;
    errorCode: string | null;
  }): Promise<void>;
  /** For `upload_media {url}`; the global fetch when unset. */
  fetch?: typeof fetch;
  now?: () => number;
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export type McpToolResult = { content: McpContent[]; isError?: boolean };

type Out = McpToolResult & { errorCode?: string };

type ToolDef = {
  name: string;
  scope: ApiScope;
  description: string;
  input: z.ZodType;
  run(d: McpDeps, input: never): Promise<Out>;
  readOnly?: boolean;
};

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const text = (v: unknown): McpContent => ({
  type: "text",
  text: typeof v === "string" ? v : JSON.stringify(v),
});
const data = (v: unknown): Out => ({ content: [text(v)] });
const failure = (code: string, message: string, details?: unknown): Out => ({
  content: [
    text({
      ok: false,
      code,
      message,
      ...(details !== undefined && { details }),
    }),
  ],
  isError: true,
  errorCode: code,
});

/** The tool's author string on revisions and threads: an OAuth connection has no key prefix. */
export const authorOf = (key: McpIdentity) =>
  key.kind === "oauth" ? `mcp:${key.name}` : mcpAuthor(key);

// ---------------------------------------------------------------------------------------------
// Pages by id or slug

const pageFields = {
  id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("The page id (from list_pages)."),
  slug: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Or the page slug, e.g. "about/team"; "" is the home page. Archived pages only by id.'
    ),
};
const ONE_REF = "Give exactly one of id or slug.";

/** A schema with the page reference fields (exactly one of them). */
function withPage<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject({ ...pageFields, ...shape }).refine((v) => {
    const ref = v as { id?: string; slug?: string };
    return (ref.id === undefined) !== (ref.slug === undefined);
  }, ONE_REF);
}

async function requirePage(
  d: McpDeps,
  ref: { id?: string; slug?: string }
): Promise<PageRow> {
  const page =
    ref.id === undefined
      ? await getPage(d.cms, { slug: ref.slug ?? "" })
      : await getPage(d.cms, { id: ref.id });
  if (!page) {
    throw new McpToolError(
      "NOT_FOUND",
      ref.id === undefined
        ? `No page at "${ref.slug}" (see list_pages)`
        : `No page with id "${ref.id}"`
    );
  }
  return page;
}

const pageInfo = (
  p: Pick<
    PageRow,
    | "id"
    | "kind"
    | "slug"
    | "title"
    | "status"
    | "draftVersion"
    | "liveRevId"
    | "updatedAt"
  >
) => ({
  id: p.id,
  kind: p.kind,
  slug: p.slug,
  title: p.title,
  status: p.status,
  draftVersion: p.draftVersion,
  liveRevId: p.liveRevId,
  updatedAt: p.updatedAt.toISOString(),
});

// ---------------------------------------------------------------------------------------------
// The built-in agent's tools

/** Runs an agent tool. Page tools (render, propose) run in this key's MCP conversation for the page. */
async function viaAgent(
  d: McpDeps,
  name: ToolName,
  input: Record<string, unknown>,
  onPage = false
): Promise<Out> {
  const ctx: ToolCtx = {
    threadId: "",
    pageId: null,
    counts: { preview: 0, share: 0, create: 0 },
    scope: { kind: "page" },
  };
  if (onPage) {
    const page = await requirePage(d, { slug: String(input.slug ?? "") });
    ctx.threadId = await mcpThread(d, page);
    ctx.pageId = page.id;
  }
  const out = await runTool(d.tools, ctx, name, input);
  const content: McpContent[] = [];
  if (typeof out.content === "string") {
    content.push(text(out.content));
  } else {
    for (const c of out.content) {
      if (c.type === "text") {
        content.push(c);
      }
    }
  }
  const image = out.image?.match(/^data:([^;]+);base64,(.+)$/);
  if (image) {
    content.push({ type: "image", mimeType: image[1]!, data: image[2]! });
  } else if (out.image) {
    content.push(text({ imageUrl: new URL(out.image, d.origin).toString() }));
  }
  if (!out.isError) {
    return { content };
  }
  let code = "TOOL_ERROR";
  try {
    code = (JSON.parse(String(out.content)) as { errors: { code: string }[] })
      .errors[0]!.code;
  } catch {
    // Not the usual error shape: keep the generic code.
  }
  return { content, isError: true, errorCode: code };
}

/** This key's conversation for the page (`mcp_<key>_<page>`), created on first use, so its proposals show in the page's AI tab and the review queue. */
export async function mcpThread(d: McpDeps, page: PageRow): Promise<string> {
  const id = `mcp_${d.key.id}_${page.id}`;
  if (await d.store.getThread(id)) {
    return id;
  }
  const at = new Date(d.now?.() ?? Date.now());
  try {
    await d.store.createThread({
      id,
      pageId: page.id,
      title:
        d.key.kind === "oauth" ? d.key.name : `Claude Code (${d.key.name})`,
      author: authorOf(d.key),
      createdAt: at,
      updatedAt: at,
      scope: "page",
    });
  } catch (err) {
    // Another call created it first.
    if (!(await d.store.getThread(id))) {
      throw err;
    }
  }
  return id;
}

const agentTool = (
  name: ToolName,
  scope: ApiScope,
  opts: { onPage?: boolean; description?: string } = {}
): ToolDef => ({
  name,
  scope,
  description: opts.description ?? DESCRIPTIONS[name],
  input: TOOL_INPUTS[name],
  readOnly: scope === "read",
  run: (d, input: Record<string, unknown>) =>
    viaAgent(d, name, input, opts.onPage),
});

// ---------------------------------------------------------------------------------------------
// Review queue

const short = (v: unknown) => {
  const t = textOf(v);
  if (t !== null) {
    return t.length > 300 ? `${t.slice(0, 300)}…` : t;
  }
  const json = JSON.stringify(v);
  return json && json.length > 300 ? `${json.slice(0, 300)}…` : v;
};
const fields = (list: FieldChange[]) =>
  list.slice(0, 40).map((f) => ({
    path: f.path || "(block)",
    kind: f.kind,
    ...(f.before !== undefined && { before: short(f.before) }),
    ...(f.after !== undefined && { after: short(f.after) }),
  }));

/** What a proposal changes, block by block, with before/after text. */
function changesOf(base: PageDoc, proposed: PageDoc) {
  const diff = diffDocs(base, proposed);
  return {
    blocks: diff.blocks.map((b) => ({
      key: b.key,
      type: b.type,
      status: b.status,
      ...(b.status === "changed" && { fields: fields(b.fields) }),
    })),
    ...(diff.seo.length && { seo: fields(diff.seo) }),
    ...(diff.post.length && { post: fields(diff.post) }),
  };
}

const sourceOf = (scope: string) =>
  scope === "site" || scope === "item" ? "run" : "conversation";

function queueEntry(cs: PendingChangeset) {
  return {
    id: cs.id,
    kind: cs.kind,
    summary: cs.summary,
    source: sourceOf(cs.threadScope),
    ...(parseItemThread(cs.threadId) && {
      runId: parseItemThread(cs.threadId)!.runId,
    }),
    threadId: cs.threadId,
    page: { id: cs.pageId, ...(cs.page ?? {}) },
    ...(cs.kind === "seo" && {
      variants: (cs.payload as SeoProposal).variants.length,
    }),
    createdAt: cs.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// The tools

const READ: ToolDef[] = [
  {
    name: "list_pages",
    scope: "read",
    description:
      "Lists the site's CMS pages and blog posts: id, slug, title, kind, status (draft/published/archived), draftVersion and when each changed. Archived pages only with includeArchived.",
    input: z.strictObject({
      kind: z
        .enum(["page", "post"])
        .optional()
        .describe("Only pages or only blog posts."),
      includeArchived: z.boolean().optional(),
    }),
    readOnly: true,
    async run(d, input: { kind?: "page" | "post"; includeArchived?: boolean }) {
      const list = (await listPages(d.cms)).filter(
        (p) =>
          (input.includeArchived || p.status !== "archived") &&
          (!input.kind || p.kind === input.kind)
      );
      return data(list.map(pageInfo));
    },
  },
  {
    ...agentTool("get_page", "read"),
    description: `${DESCRIPTIONS.get_page} The result includes the page id and chrome ("site": the site's navigation and footer around the page; "none": the page draws its own). Pass draftVersion to update_page and publish_page.`,
    async run(d, input: { slug: string; mode: "outline" | "full" }) {
      const out = await viaAgent(d, "get_page", input);
      if (out.isError) {
        return out;
      }
      const page = await requirePage(d, { slug: input.slug });
      return data({
        id: page.id,
        liveRevId: page.liveRevId,
        chrome: page.draftDoc?.chrome ?? "site",
        ...JSON.parse((out.content[0] as { text: string }).text),
      });
    },
  },
  agentTool("get_block", "read"),
  agentTool("list_block_types", "read"),
  agentTool("list_style_tokens", "read"),
  agentTool("search_media", "read"),
  agentTool("get_site_context", "read"),
  agentTool("audit_seo", "read"),
  agentTool("get_seo_overview", "read"),
  agentTool("get_search_performance", "read"),
  agentTool("find_seo_opportunities", "read"),
  agentTool("get_preview_url", "read"),
  {
    name: "list_revisions",
    scope: "read",
    description:
      "A page's version history, newest first: id, kind (autosnapshot, named, published, agent, restore), label, summary, author (a Clerk user id, mcp:<key name>#<key prefix>, or mcp:<app> (<date>) for an OAuth connection) and time, plus pinned versions. Page by id or slug.",
    input: withPage({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    readOnly: true,
    async run(
      d,
      input: { id?: string; slug?: string; limit?: number; offset?: number }
    ) {
      const page = await requirePage(d, input);
      const h = await revisionHistory(d.cms, page.id, {
        limit: input.limit ?? 30,
        offset: input.offset ?? 0,
      });
      const row = (r: (typeof h.revisions)[number]) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        summary: r.summary,
        author: r.author,
        agentRunId: r.agentRunId,
        createdAt: r.createdAt.toISOString(),
        ...(r.id === page.liveRevId &&
          page.status === "published" && { live: true }),
        ...(r.pinned && { pinned: true }),
      });
      return data({
        page: pageInfo(h.page),
        revisions: h.revisions.map(row),
        ...(h.pinned.length && { pinned: h.pinned.map(row) }),
        hasMore: h.hasMore,
      });
    },
  },
  {
    name: "get_revision",
    scope: "read",
    description:
      "One version of a page with its whole document (blocks with editor rich-text JSON, SEO, post details). Page by id or slug; revId from list_revisions.",
    input: withPage({ revId: z.string().min(1).max(64) }),
    readOnly: true,
    async run(d, input: { id?: string; slug?: string; revId: string }) {
      const page = await requirePage(d, input);
      const rev = await pageRevision(d.cms, page.id, input.revId);
      return data({
        id: rev.id,
        pageId: rev.pageId,
        kind: rev.kind,
        label: rev.label,
        summary: rev.summary,
        author: rev.author,
        createdAt: rev.createdAt.toISOString(),
        doc: rev.docJson,
      });
    },
  },
  {
    name: "list_review_queue",
    scope: "read",
    description:
      "Every pending agent proposal (changeset), newest first: its id, page, kind (ops: content and style; seo: title options and SEO fields), summary and source (run: a site-wide run's item; conversation: a page conversation in the AI tab or over MCP). Optionally one page's only. Read one with get_changeset, decide with accept_changeset or reject_changeset.",
    input: z.strictObject({ ...pageFields }),
    readOnly: true,
    async run(d, input: { id?: string; slug?: string }) {
      const pageId =
        input.id !== undefined || input.slug !== undefined
          ? (await requirePage(d, input)).id
          : undefined;
      const pending = await d.store.pendingChangesets(pageId);
      return data({ pending: pending.map(queueEntry) });
    },
  },
  {
    name: "get_changeset",
    scope: "read",
    description:
      "One proposal in full: its ops (or SEO proposal with its title/description variants), what it changes block by block with before/after text, and, while pending, which of its blocks changed on the page since it was staged (conflicts) and the page's current draftVersion.",
    input: z.strictObject({
      id: z
        .string()
        .min(1)
        .max(64)
        .describe("The changeset id (list_review_queue)."),
    }),
    readOnly: true,
    async run(d, input: { id: string }) {
      const cs = await d.store.getChangeset(input.id);
      if (!cs) {
        throw new McpToolError("NOT_FOUND", `No changeset "${input.id}"`);
      }
      const page = await getPage(d.cms, { id: cs.pageId });
      const pending = cs.status === "pending" && page?.draftDoc;
      return data({
        id: cs.id,
        kind: cs.kind,
        status: cs.status,
        summary: cs.summary,
        source: sourceOf(
          (await d.store.getThread(cs.threadId))?.scope ?? "page"
        ),
        threadId: cs.threadId,
        page: page
          ? {
              id: page.id,
              slug: page.slug,
              title: page.title,
              status: page.status,
              draftVersion: page.draftVersion,
            }
          : { id: cs.pageId },
        createdAt: cs.createdAt.toISOString(),
        ...(cs.kind === "ops"
          ? { ops: (cs.payload as { ops: Op[] }).ops }
          : { seo: cs.payload }),
        changes: changesOf(cs.baseDoc, cs.proposedDoc),
        ...(Array.isArray(cs.warnings) &&
          cs.warnings.length && { warnings: cs.warnings }),
        ...(pending &&
          cs.kind === "ops" && {
            conflicts: conflicts(
              cs.baseDoc,
              page.draftDoc!,
              (cs.payload as { ops: Op[] }).ops
            ),
          }),
        ...(cs.decision && { decision: cs.decision }),
      });
    },
  },
  {
    name: "get_site",
    scope: "read",
    description:
      "The site settings document (navigation, footer, brand swatches, contact details…): the draft, its draftVersion, the live version, and what publishing would change.",
    input: z.strictObject({}),
    readOnly: true,
    async run(d) {
      const s = await getSiteState(d.site);
      return data({
        draftVersion: s.draftVersion,
        liveRevId: s.liveRevId,
        unpublishedChanges: s.changes,
        draft: s.doc,
        live: s.liveDoc,
      });
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Write

const draftVersion = z
  .number()
  .int()
  .min(0)
  .describe(
    "The draftVersion you read (get_page). A stale one fails with STALE_DRAFT and the current version; re-read the page."
  );
const opsInput = z.array(z.record(z.string(), z.unknown())).min(1).max(60);

const UPDATE_HELP = `Applies ops to a page's draft right away (no review): the editor and the AI tab see it at once. Nothing goes live until publish_page. Rich-text props take Markdown; new blocks get a _key when they have none. Besides the ops below, {"op":"setSeo","seo":{…}} patches the SEO settings (merge-patch: title, description, focusKeyphrase, social, robots, schema, llms; not the slug).
Each op is one of:
- {"op":"insert","at":{"after":"<key>"}|{"before":"<key>"}|{"index":n}|{},"block":{"_key"?:"<new key>","_type":"<type>","props":{…},"style"?:{…}}}
- {"op":"update","key":"<key>","props"?:{…},"style"?:{…}} (JSON merge-patch: only keys you send change, null removes, arrays replace whole)
- {"op":"replace","key":"<key>","block":{"_type":"<type>","props":{…},"style"?:{…}}}
- {"op":"move","key":"<key>","to":{"after":"<key>"}|{"before":"<key>"}|{"index":n}}
- {"op":"remove","key":"<key>"}
- {"op":"setPost","post":{…}} (blog posts only)
Use propose_ops instead when a person should review the change first.`;

/** `update_page`: the agent's op format (Markdown, optional keys) through `stageOps`; `setSeo` ops as they are. */
async function updatePage(
  d: McpDeps,
  input: {
    id?: string;
    slug?: string;
    draftVersion: number;
    ops: Record<string, unknown>[];
    batchId?: string;
  }
): Promise<Out> {
  const page = await requirePage(d, input);
  if (!page.draftDoc) {
    throw new McpToolError("NOT_FOUND", "The page has no draft.");
  }
  if (page.status === "archived") {
    throw new McpToolError(
      "ARCHIVED",
      "The page is archived; unarchive_page it first."
    );
  }
  if (page.draftVersion !== input.draftVersion) {
    throw new CmsError(
      "STALE_DRAFT",
      "the draft changed since it was loaded; reload it",
      { current: page.draftVersion }
    );
  }
  const seoOps = input.ops.filter((o) => o.op === "setSeo");
  const rest = input.ops.filter((o) => o.op !== "setSeo");
  let ops: unknown[] = seoOps;
  let warnings: unknown[] = [];
  if (rest.length) {
    const staged = stageOps(page.draftDoc, rest);
    if (!staged.ok) {
      return failure(staged.errors[0]!.code, staged.errors[0]!.message, {
        errors: staged.errors,
      });
    }
    ops = [...staged.ops, ...seoOps];
    warnings = staged.warnings;
  }
  const saved = await applyDraftOps(
    d.cms,
    page.id,
    input.draftVersion,
    ops,
    input.batchId
  );
  return data({
    ok: true,
    id: page.id,
    slug: page.slug,
    draftVersion: saved.draftVersion,
    changes: changesOf(page.draftDoc, saved.doc),
    ...(warnings.length && { warnings }),
    note:
      page.status === "published"
        ? "Saved to the draft; the live page changes when you publish_page."
        : "Saved to the draft.",
  });
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const FETCH_FAILED = "Fetching the image failed.";

/**
 * Why a URL may not be fetched, or null if it may: https only (http too when the site origin is
 * http, i.e. local dev), and a public host name. The URL parser has already normalised IPv4 forms
 * like `2130706433` and `0x7f.1` to dotted quads. Names that resolve to private addresses can't be
 * caught here (a Worker has no resolver), but a Worker's fetch doesn't reach private networks.
 */
function blockedReason(d: McpDeps, url: URL): string | null {
  const httpOk =
    url.protocol === "http:" && new URL(d.origin).protocol === "http:";
  if (url.protocol !== "https:" && !httpOk) {
    return "scheme";
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || IPV4.test(host)) {
    return "IP literal";
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    return "internal host";
  }
  return null;
}

function checkUrl(d: McpDeps, url: URL): void {
  const reason = blockedReason(d, url);
  if (reason) {
    console.error(`mcp upload_media: blocked ${url.host} (${reason})`);
    throw new McpToolError(
      "BLOCKED_URL",
      "Only https URLs on public host names can be fetched."
    );
  }
}

const errName = (err: unknown) => (err instanceof Error ? err.name : "error");

/** A FETCH_FAILED tool error; the reason goes to the log (host only: a path or query may carry a secret). */
function fetchFailed(url: URL, reason: string): McpToolError {
  console.error(
    `mcp upload_media: fetching from ${url.host} failed: ${reason}`
  );
  return new McpToolError("FETCH_FAILED", FETCH_FAILED);
}

/** Fetches `url`, following at most 3 redirects by hand and checking every hop like the first. */
async function fetchFollowing(
  d: McpDeps,
  start: URL,
  signal: AbortSignal
): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await (d.fetch ?? fetch)(url.toString(), {
        headers: { Accept: "image/*" },
        redirect: "manual",
        signal,
      });
    } catch (err) {
      throw fetchFailed(url, errName(err));
    }
    if (res.status < 300 || res.status > 399) {
      return { res, url };
    }
    await res.body?.cancel();
    const location = res.headers.get("Location");
    if (!location) {
      throw fetchFailed(url, `HTTP ${res.status} without Location`);
    }
    if (hop >= MAX_REDIRECTS) {
      throw fetchFailed(url, "too many redirects");
    }
    try {
      url = new URL(location, url);
    } catch {
      throw fetchFailed(url, "invalid redirect Location");
    }
    checkUrl(d, url);
  }
}

/** The response body, at most 10 MB. */
async function readCapped(
  url: URL,
  body: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw fetchFailed(url, errName(err));
    }
    const { done, value } = chunk;
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw new MediaError("TOO_LARGE", "Images can be at most 10 MB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

/**
 * Reads an image from a public https URL, at most 10 MB, image content types only. Redirects are
 * followed by hand (at most 3), each hop checked like the first; the whole read times out after 10 s.
 */
async function fetchImage(d: McpDeps, raw: string): Promise<Uint8Array> {
  let start: URL;
  try {
    start = new URL(raw);
  } catch {
    throw new McpToolError("INVALID_INPUT", "url isn't a valid URL.");
  }
  checkUrl(d, start);
  const { res, url } = await fetchFollowing(
    d,
    start,
    AbortSignal.timeout(FETCH_TIMEOUT_MS)
  );
  if (!(res.ok && res.body)) {
    await res.body?.cancel();
    throw fetchFailed(url, `HTTP ${res.status}`);
  }
  const type = res.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("image/")) {
    await res.body.cancel();
    throw fetchFailed(url, `Content-Type ${type || "missing"}`);
  }
  if (Number(res.headers.get("Content-Length") ?? 0) > MAX_MEDIA_BYTES) {
    await res.body.cancel();
    throw new MediaError("TOO_LARGE", "Images can be at most 10 MB.");
  }
  return readCapped(url, res.body);
}

function fromBase64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  } catch {
    throw new McpToolError("INVALID_INPUT", "base64 isn't valid base64.");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

const review = (d: McpDeps) => ({
  cms: d.cms,
  store: d.store,
  ...(d.now && { now: () => new Date(d.now!()) }),
});

const WRITE: ToolDef[] = [
  {
    name: "update_page",
    scope: "write",
    description: UPDATE_HELP,
    input: withPage({
      draftVersion,
      ops: opsInput,
      batchId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "Optional idempotency key: resending the same batch with the same draftVersion after a lost response succeeds once."
        ),
    }),
    run: (d, input: Parameters<typeof updatePage>[1]) => updatePage(d, input),
  },
  agentTool("create_page", "write", {
    description:
      "Creates a NEW page or blog post as an unpublished DRAFT (it never publishes) and returns its id and editor link. Checks the slug (taken, reserved, format). Pass the blocks in full, or omit them for the default start, then edit with update_page or propose_ops. Posts default their category and author to the latest post's.",
  }),
  agentTool("duplicate_page", "write", {
    description:
      'Copies a CMS page or post to a NEW slug as an unpublished DRAFT and returns its id and editor link. A published original is copied as it is live; otherwise its draft. The copy keeps the blocks and styles; its share image and canonical URL are cleared, its SEO title starts with "Copy of" and it is set to noindex (turn indexing back on with update_page setSeo robots when it\'s ready).',
  }),
  {
    name: "create_post",
    scope: "write",
    description:
      "Creates a draft blog post at blog/<slug> with an empty body, the given category and author, dated today (as the admin's New post dialog does). Write the body with update_page.",
    input: z.strictObject({
      slug: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'The part after blog/, e.g. "my-first-post" (a full "blog/…" slug works too).'
        ),
      title: z.string().min(1).max(200),
      category: z.string().min(1).max(100),
      author: z.string().min(1).max(100),
    }),
    async run(
      d,
      input: { slug: string; title: string; category: string; author: string }
    ) {
      const slug = input.slug.startsWith("blog/")
        ? input.slug
        : `blog/${input.slug}`;
      await checkSlugAvailable(d.cms, "post", slug);
      const page = await createPage(d.cms, {
        kind: "post",
        slug,
        title: input.title.trim(),
        doc: newPostDoc({
          title: input.title.trim(),
          slug,
          category: input.category.trim(),
          author: input.author.trim(),
          timeZone: d.site.config.timeZone,
        }),
      });
      return data({
        ok: true,
        id: page.id,
        slug: page.slug,
        status: "draft (not published)",
        draftVersion: page.draftVersion,
        editorUrl: new URL(`/admin/editor/${page.id}`, d.origin).toString(),
      });
    },
  },
  agentTool("propose_ops", "write", {
    onPage: true,
    description: `${DESCRIPTIONS.propose_ops}\nOver MCP the proposal lands in this key's conversation for the page (the page's AI tab) and in list_review_queue; accept it with accept_changeset, or change the draft directly with update_page.`,
  }),
  agentTool("propose_seo", "write", {
    onPage: true,
    description: `${DESCRIPTIONS.propose_seo} Over MCP it lands in list_review_queue; accept it with accept_changeset and a variant.`,
  }),
  agentTool("render_preview", "write", { onPage: true }),
  agentTool("render_share_image", "write", { onPage: true }),
  {
    name: "accept_changeset",
    scope: "write",
    description:
      'Accepts a pending proposal (list_review_queue): its ops are applied to the page\'s draft in one commit, recorded as an agent revision. groups: the block keys to take (default all; "seo"/"post" for those ops). variant (0–2): required for an SEO proposal, the title/description option to use. A proposal whose blocks changed on the page since it was staged is refused (LIVE_CHANGED with the conflicts) unless you pass the draftVersion you reviewed and list those blocks in confirmConflicts. Never publishes.',
    input: z.strictObject({
      id: z.string().min(1).max(64).describe("The changeset id."),
      groups: z.array(z.string().max(64)).max(200).optional(),
      variant: z.number().int().min(0).max(2).optional(),
      draftVersion: draftVersion.optional(),
      confirmConflicts: z.array(z.string().max(64)).max(200).optional(),
    }),
    async run(
      d,
      input: {
        id: string;
        groups?: string[];
        variant?: number;
        draftVersion?: number;
        confirmConflicts?: string[];
      }
    ) {
      const { id, ...rest } = input;
      const res = await acceptChangeset(review(d), {
        changesetId: id,
        ...rest,
      });
      return data({
        ok: true,
        ...res,
        note: "Applied to the draft. Publish with publish_page.",
      });
    },
  },
  {
    name: "reject_changeset",
    scope: "write",
    description: "Rejects a pending proposal; the page is untouched.",
    input: z.strictObject({
      id: z.string().min(1).max(64).describe("The changeset id."),
    }),
    async run(d, input: { id: string }) {
      return data({
        ok: true,
        ...(await rejectChangeset(review(d), input.id)),
      });
    },
  },
  {
    name: "review_run_item",
    scope: "write",
    description:
      "The review queue's per-page decision for a site-wide run item: accept takes all its pending proposals (content first, then SEO with variant, required when there is one) and keeps a draft it created; reject rejects them and archives the draft it created (while still unpublished).",
    input: z.strictObject({
      runId: z.string().min(1).max(80),
      itemId: z.string().min(1).max(80),
      decision: z.enum(["accept", "reject"]),
      variant: z.number().int().min(0).max(2).optional(),
    }),
    async run(
      d,
      input: {
        runId: string;
        itemId: string;
        decision: "accept" | "reject";
        variant?: number;
      }
    ) {
      const { run } = await reviewRunItem(review(d), input);
      const item = run.items.find((i) => i.id === input.itemId);
      return data({
        ok: true,
        run: { id: run.id, status: run.status },
        item: item && { id: item.id, slug: item.slug, status: item.status },
      });
    },
  },
  {
    name: "save_version",
    scope: "write",
    description:
      "Saves the page's current draft as a named version in its history (like the editor's Save version…). With draftVersion, only if that is still the draft.",
    input: withPage({
      label: z.string().min(1).max(100),
      draftVersion: draftVersion.optional(),
    }),
    async run(
      d,
      input: {
        id?: string;
        slug?: string;
        label: string;
        draftVersion?: number;
      }
    ) {
      const page = await requirePage(d, input);
      const rev = await saveVersion(
        d.cms,
        page.id,
        input.label.trim(),
        input.draftVersion
      );
      return data({ ok: true, revId: rev.id, label: rev.label });
    },
  },
  {
    name: "restore_revision",
    scope: "write",
    description:
      "Makes an old version (list_revisions) the page's draft, as a new restore revision; nothing is lost (the current draft is snapshotted first). Blocks that no longer validate are dropped and listed. Doesn't publish.",
    input: withPage({ revId: z.string().min(1).max(64), draftVersion }),
    async run(
      d,
      input: { id?: string; slug?: string; revId: string; draftVersion: number }
    ) {
      const page = await requirePage(d, input);
      const res = await restore(
        d.cms,
        page.id,
        input.revId,
        input.draftVersion
      );
      return data({
        ok: true,
        revId: res.revId,
        draftVersion: res.draftVersion,
        dropped: res.dropped,
        seoReplaced: res.seoReplaced,
      });
    },
  },
  {
    name: "upload_media",
    scope: "write",
    description:
      "Adds an image to the media library from base64 bytes or an http(s) URL the server fetches (JPEG, PNG, WebP, GIF, AVIF; at most 10 MB). Identical files are deduplicated. Returns the mediaId to use in image props and the share image.",
    input: z
      .strictObject({
        base64: z
          .string()
          .max(14_000_000)
          .optional()
          .describe("The file's bytes as base64 (a data: URL prefix is fine)."),
        url: z.string().max(2000).optional(),
        alt: z
          .string()
          .max(300)
          .optional()
          .describe("Alt text describing the image."),
      })
      .refine(
        (v) => (v.base64 === undefined) !== (v.url === undefined),
        "Give exactly one of base64 or url."
      ),
    async run(d, input: { base64?: string; url?: string; alt?: string }) {
      const bytes =
        input.base64 === undefined
          ? await fetchImage(d, input.url!)
          : fromBase64(input.base64);
      const { media, created } = await uploadMedia(d.media, {
        bytes,
        alt: input.alt ?? null,
        source: "upload",
      });
      return data({
        ok: true,
        created,
        mediaId: media.id,
        url: new URL(media.url, d.origin).toString(),
        width: media.width,
        height: media.height,
        mime: media.mime,
        alt: media.alt,
      });
    },
  },
  {
    name: "update_media",
    scope: "write",
    description:
      "Sets an image's alt text (and optionally its tags) in the media library.",
    input: z.strictObject({
      id: z.string().min(1).max(80).describe("The mediaId."),
      alt: z.string().max(300),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
    async run(d, input: { id: string; alt: string; tags?: string[] }) {
      const media = await updateMediaAlt(d.media, input);
      return data({
        ok: true,
        mediaId: media.id,
        alt: media.alt,
        tags: media.tags,
      });
    },
  },
  {
    name: "save_site_draft",
    scope: "write",
    description:
      "Replaces the site settings draft (get_site's draft: navigation, footer, swatches, contact…) with doc, validated, if draftVersion is still current. Send the whole document. The public site changes when you publish_site.",
    input: z.strictObject({
      draftVersion,
      doc: z.record(z.string(), z.unknown()),
    }),
    async run(d, input: { draftVersion: number; doc: unknown }) {
      const saved = await saveSiteDraft(d.site, input.draftVersion, input.doc);
      return data({ ok: true, draftVersion: saved.draftVersion });
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Publish

const NOT_LIVE =
  "Saved in D1, but the live site wasn't updated (KV write failed): call republish_page.";

function published(
  d: McpDeps,
  page: PageRow,
  res: PublishResult,
  slug = page.slug
): Out {
  return data({
    ok: true,
    live: res.live,
    revId: res.revId,
    url: new URL(slugToPath(slug), d.origin).toString(),
    ...(!res.live && { note: NOT_LIVE }),
  });
}

const PUBLISH: ToolDef[] = [
  {
    name: "publish_page",
    scope: "full",
    description:
      "Publishes the page's draft as it is at draftVersion (get_page): it goes live on the public site at once, old slugs redirect to the new one. expectedLiveRevId (optional: the liveRevId you compared against, null when it wasn't live) refuses with LIVE_CHANGED if the live page moved since. live:false means D1 has it but the site doesn't yet: call republish_page.",
    input: withPage({
      draftVersion,
      expectedLiveRevId: z.string().max(64).nullable().optional(),
    }),
    async run(
      d,
      input: {
        id?: string;
        slug?: string;
        draftVersion: number;
        expectedLiveRevId?: string | null;
      }
    ) {
      const page = await requirePage(d, input);
      const res = await publish(
        d.cms,
        page.id,
        input.draftVersion,
        input.expectedLiveRevId === undefined
          ? {}
          : { expectedLiveRevId: input.expectedLiveRevId }
      );
      const after = (await getPage(d.cms, { id: page.id })) ?? page;
      return published(d, after, res);
    },
  },
  {
    name: "republish_page",
    scope: "full",
    description:
      "Rewrites the live site from the page's live version (the retry after publish_page returned live:false). Changes nothing in D1.",
    input: withPage({}),
    async run(d, input: { id?: string; slug?: string }) {
      const page = await requirePage(d, input);
      return published(d, page, await republish(d.cms, page.id));
    },
  },
  {
    name: "unpublish_page",
    scope: "full",
    description:
      "Takes the page off the public site; it stays as a draft. Its old slugs stop redirecting.",
    input: withPage({}),
    async run(d, input: { id?: string; slug?: string }) {
      const page = await requirePage(d, input);
      const res = await unpublish(d.cms, page.id);
      return data({
        ok: true,
        status: "draft",
        synced: res.synced,
        ...(!res.synced && {
          note: "D1 is updated but the live site may still show it (KV failed); try again.",
        }),
      });
    },
  },
  {
    name: "archive_page",
    scope: "full",
    description:
      "The CMS's delete: takes the page off the site (if live) and archives it. Its slug becomes free; its history stays, and unarchive_page brings it back as a draft. Pages are never hard-deleted.",
    input: withPage({}),
    async run(d, input: { id?: string; slug?: string }) {
      const page = await requirePage(d, input);
      const res = await archivePage(d.cms, page.id);
      return data({
        ok: true,
        id: page.id,
        status: "archived",
        synced: res.synced,
      });
    },
  },
  {
    name: "unarchive_page",
    scope: "full",
    description:
      "Brings an archived page (list_pages includeArchived; by id) back as an unpublished draft at its old slug, if that slug is still free. Publish it again with publish_page.",
    input: z.strictObject({
      id: z.string().min(1).max(64).describe("The archived page's id."),
    }),
    async run(d, input: { id: string }) {
      const page = await unarchivePage(d.cms, input.id);
      return data({ ok: true, ...pageInfo(page) });
    },
  },
  {
    name: "rollback_live",
    scope: "full",
    description:
      "Makes an earlier published version (list_revisions, kind published) live again, at the page's current slug. The draft is untouched. Only for a page that is live now.",
    input: withPage({ revId: z.string().min(1).max(64) }),
    async run(d, input: { id?: string; slug?: string; revId: string }) {
      const page = await requirePage(d, input);
      return published(
        d,
        page,
        await rollbackLive(d.cms, page.id, input.revId)
      );
    },
  },
  {
    name: "publish_site",
    scope: "full",
    description:
      "Publishes the site settings draft (get_site) at draftVersion: navigation, footer and the rest change on every page at once.",
    input: z.strictObject({ draftVersion }),
    async run(d, input: { draftVersion: number }) {
      const res = await publishSite(d.site, input.draftVersion);
      return data({
        ok: true,
        live: res.live,
        revId: res.revId,
        summary: res.summary,
        ...(!res.live && {
          note: "Saved, but the live site wasn't updated (KV write failed); publish again.",
        }),
      });
    },
  },
];

export const MCP_TOOLS: ToolDef[] = [...READ, ...WRITE, ...PUBLISH];

const BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

/** What the call log records as the target: the page id or slug, or the changeset or media id. */
function targetOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const o = input as Record<string, unknown>;
  for (const k of ["id", "slug", "to", "from"]) {
    if (typeof o[k] === "string") {
      return o[k] as string;
    }
  }
  return null;
}

/**
 * One tool call: scope check, input parse, run, error mapping, call log. Never throws for
 * expected problems; an unexpected one is logged and returned as INTERNAL.
 */
export async function callMcpTool(
  d: McpDeps,
  name: string,
  rawInput: unknown
): Promise<McpToolResult> {
  const def = BY_NAME.get(name);
  let out: Out;
  if (!def) {
    out = failure("NOT_FOUND", `No tool called "${name}"`);
  } else if (scopeAllows(d.key.scope, def.scope)) {
    const parsed = def.input.safeParse(rawInput ?? {});
    if (parsed.success) {
      try {
        out = await def.run(d, parsed.data as never);
      } catch (err) {
        out = errorOut(name, err);
      }
    } else {
      out = failure(
        "INVALID_INPUT",
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
          .join("; ")
      );
    }
  } else {
    out = failure(
      "SCOPE",
      d.key.kind === "oauth"
        ? `${name} needs the "${def.scope}" scope; this connection ("${d.key.name}") has "${d.key.scope}". Disconnect and connect again with a broader scope.`
        : `${name} needs an API key with the "${def.scope}" scope; this key ("${d.key.name}") has "${d.key.scope}". Create one in /admin/api-keys.`
    );
  }
  try {
    await d.log({
      tool: name,
      target: targetOf(rawInput),
      ok: !out.isError,
      errorCode: out.errorCode ?? null,
    });
  } catch (err) {
    console.error("mcp: could not log the call", err);
  }
  const { errorCode: _code, ...result } = out;
  return result;
}

function errorOut(name: string, err: unknown): Out {
  if (
    err instanceof McpToolError ||
    err instanceof CmsError ||
    err instanceof MediaError ||
    err instanceof RunError
  ) {
    return failure(
      err.code,
      err.message,
      "details" in err ? err.details : undefined
    );
  }
  // The detail stays in the log: it may name tables, bindings or upstream responses.
  console.error(`mcp tool ${name} failed`, err);
  return failure("INTERNAL", "Internal error");
}

/** The tools as the MCP server lists them. */
export function mcpToolList(): {
  name: string;
  description: string;
  scope: ApiScope;
  input: z.ZodType;
  readOnly: boolean;
}[] {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: `${t.description} (Scope: ${t.scope}.)`,
    scope: t.scope,
    input: t.input,
    readOnly: !!t.readOnly,
  }));
}
