// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.

import {
  type EditorPage,
  editorPageFromWire,
} from "@repo/cms-core/admin-result";
import type { BlockType } from "@repo/cms-core/blocks/registry";
import { defaultInsertAt, insertNew } from "@repo/cms-core/editor/block-ops";
import {
  getIn,
  type Path,
  propsPatch,
} from "@repo/cms-core/editor/inspector-fields";
import { slugToPath } from "@repo/cms-core/paths";
import {
  POST_BLOCK_TYPES,
  postBlockStyle,
  withReadingTime,
} from "@repo/cms-core/posts";
import type { RichTextDoc } from "@repo/cms-core/richtext/schema";
import type { Device, InsertAt } from "@repo/cms-core/types";
import { parseBlock } from "@repo/cms-core/validate";
import { Link } from "@tanstack/react-router";
import { createTRPCClient, httpLink } from "@trpc/client";
import {
  ArrowLeft,
  Eye,
  Monitor,
  Redo2,
  Smartphone,
  Tablet,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { AppRouter } from "#/server/trpc/router";
import { AgentCanvasMarks, AgentReviewBar } from "../agent/ui/agent-canvas";
import { AgentPanel } from "../agent/ui/agent-panel";
import {
  AgentView,
  AgentViewContext,
  useAgentPreviewDoc,
} from "../agent/ui/agent-view";
import { EditModeContext, type RichTextSlotArgs } from "../render/edit-mode";
import { PageRenderer } from "../render/page-renderer";
import { PostLayout } from "../render/post-layout";
import { CmsRenderContext, type CmsRenderData } from "../render/render-context";
import { BlockPalette } from "./block-palette";
import {
  CanvasFrame,
  DEVICE_PRESETS,
  deviceForWidth,
  editorShortcut,
} from "./canvas-frame";
import { CanvasTools } from "./canvas-tools";
import {
  HistoryCanvasMarks,
  HistoryDialogs,
  HistoryPanel,
  HistoryView,
  HistoryViewContext,
  HistoryViewingBar,
  SaveVersionButton,
  useViewingDoc,
} from "./history-panel";
import { Inspector } from "./inspector";
import { LayersPanel } from "./layers-panel";
import { PostPanel } from "./post-panel";
import { PublishDialog } from "./publish-dialog";
import { RichTextEditor, richTextNotice } from "./rich-text-editor";
import { SeoPanel, usePublishSeoWarnings } from "./seo-panel";
import { signedOutAsResult } from "./signed-out";
import { type EditorInit, EditorStore, type SaveStatus } from "./store";
import { UnpublishDialog } from "./unpublish-dialog";
import {
  EditorStoreContext,
  useEditorState,
  useEditorStore,
} from "./use-editor-store";

/**
 * The page editor: top bar, layers + palette on the left, the canvas in the
 * middle, the inspector on the right. Loaded lazily by src/routes/admin.editor.$pageId.tsx, so none
 * of this (TipTap, dnd-kit, the block registry) reaches the public bundle.
 */
export default function PageEditor({
  pageId,
  initial,
}: {
  pageId: string;
  initial: EditorPage;
}) {
  const [store] = useState(
    () =>
      new EditorStore(initFrom(initial), {
        save: (draftVersion, ops, batchId, opts) =>
          signedOutAsResult(() =>
            (opts?.keepalive
              ? keepaliveTrpc()
              : getTrpc()
            ).cms.pages.saveDraftOps.mutate({
              pageId,
              draftVersion,
              ops,
              batchId,
            })
          ),
        publish: (draftVersion, opts) =>
          signedOutAsResult(() =>
            getTrpc().cms.pages.publishPage.mutate({
              pageId,
              draftVersion,
              ...(opts?.expectedLiveRevId !== undefined && {
                expectedLiveRevId: opts.expectedLiveRevId,
              }),
            })
          ),
        validateBlock: (block) => parseBlock(block).errors,
      })
  );
  const [history] = useState(() => new HistoryView(store, pageId));
  // The AI tab: chat, and proposals reviewed on the canvas.
  const [agent] = useState(
    () =>
      new AgentView(store, pageId, (message, error) =>
        error ? toast.error(message) : toast(message)
      )
  );

  // Shortcuts in the editor window; the canvas forwards its own (CanvasFrame onKeyDown).
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const action = editorShortcut(e);
      if (!action) {
        return;
      }
      e.preventDefault();
      if (action === "save") {
        void store.save();
      } else if (action === "saveVersion") {
        if (!busyElsewhere(e)) {
          history.openDialog({ kind: "save" });
        }
      } else if (action === "undo") {
        store.undo();
      } else {
        store.redo();
      }
    },
    [store, history]
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    // Best effort: save on the way out (keepalive, so the request survives the page), and ask
    // before leaving with unsaved changes. A save still in flight goes first; the keepalive one
    // only starts after it, which may be too late.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      store.flushEdits();
      if (!store.dirty) {
        return;
      }
      void store.save({ keepalive: true });
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      store.flushEdits();
      void store.dispose();
    };
  }, [store, onKeyDown]);

  return (
    <EditorStoreContext.Provider value={store}>
      <HistoryViewContext.Provider value={history}>
        <AgentViewContext.Provider value={agent}>
          <EditorLayout
            pageId={pageId}
            page={initial.page}
            onKeyDown={onKeyDown}
          />
          <HistoryDialogs />
        </AgentViewContext.Provider>
      </HistoryViewContext.Provider>
    </EditorStoreContext.Provider>
  );
}

function initFrom(data: EditorPage): EditorInit {
  return {
    doc: data.draftDoc,
    draftVersion: data.draftVersion,
    pageStatus: data.page.status,
    hasUnpublishedChanges: data.hasUnpublishedChanges,
  };
}

const notice = (message: string) => toast.error(message);

/**
 * "Save version…" stays out of the way while a dialog is open or the user is typing (a form field,
 * or text edited in place on the canvas or in rich text).
 */
function busyElsewhere(e: KeyboardEvent): boolean {
  if (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
    )
  ) {
    return true;
  }
  const target = e.target as Element | null;
  return !!target?.closest?.(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
  );
}

/** Browsers refuse keepalive requests whose body is over 64 KiB; a bigger save goes as a normal request. */
const KEEPALIVE_MAX_BYTES = 60_000;
const keepaliveFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, {
    ...init,
    keepalive:
      typeof init?.body === "string" &&
      new Blob([init.body]).size <= KEEPALIVE_MAX_BYTES,
  });

/**
 * For the save on the way out of the page: its own unbatched link over `keepaliveFetch` (the
 * shared client's batch link can't mark a single request keepalive). Browser only, like the editor.
 */
let keepaliveClient: ReturnType<typeof createTRPCClient<AppRouter>> | null =
  null;
const keepaliveTrpc = () => {
  keepaliveClient ??= createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "/api/trpc",
        transformer: superjson,
        fetch: keepaliveFetch,
      }),
    ],
  });
  return keepaliveClient;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; the layout's view switches (history, agent review, tabs) kept together as in the source.
function EditorLayout({
  pageId,
  page,
  onKeyDown,
}: {
  pageId: string;
  page: EditorPage["page"];
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const store = useEditorStore();
  const { doc, selectedKey, pageStatus } = useEditorState();
  const readOnly = pageStatus === "archived";
  const [width, setWidth] = useState(DEVICE_PRESETS.desktop.width);
  const device = deviceForWidth(width);
  const [paletteAt, setPaletteAt] = useState<InsertAt | null>(null);
  // Posts open in the writing layout: the article column on the canvas, a Post tab, and the blocks a post uses.
  const isPost = page.kind === "post";
  const sideTabs = isPost
    ? (["inspector", "post", "seo", "history", "ai"] as const)
    : (["inspector", "seo", "history", "ai"] as const);
  // `#seo` (links from /admin/seo) opens the SEO tab; `?review=` and `?agent=site` (links from a site-wide run) the AI tab.
  const [sideTab, setSideTab] = useState<SideTab>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("review") || params.get("agent") === "site") {
      return "ai";
    }
    return window.location.hash === "#seo" ? "seo" : "inspector";
  });
  // A version picked in History replaces the draft on the canvas, read-only.
  const viewingDoc = useViewingDoc();
  const renderData = usePublishedPosts();

  const insert = (type: BlockType) => {
    const at = paletteAt ?? {};
    setPaletteAt(null);
    const res = store.apply([
      insertNew(type, at, isPost ? postBlockStyle(type) : undefined),
    ]);
    if (!res.ok) {
      notice(res.errors[0]?.message ?? "The block couldn't be added");
    }
  };
  // An agent proposal under review replaces the draft on the canvas, read-only (ghost overlay).
  const agentDoc = useAgentPreviewDoc(doc);
  const canvasDoc = viewingDoc ?? agentDoc ?? doc;

  const renderRichText = useCallback(
    (args: RichTextSlotArgs) => <CanvasRichText {...args} />,
    []
  );
  // Read-only (archived): blocks still select, rich text renders as on the site.
  const editMode = useMemo(
    () =>
      viewingDoc || agentDoc
        ? { editing: true, device, selectedKey: null }
        : {
            editing: true,
            device,
            selectedKey,
            renderRichText: readOnly ? undefined : renderRichText,
          },
    [device, selectedKey, renderRichText, readOnly, viewingDoc, agentDoc]
  );

  return (
    <div
      className="flex h-screen flex-col bg-background font-sans text-foreground"
      data-testid="page-editor"
    >
      <TopBar page={page} width={width} setWidth={setWidth} device={device} />
      <ConflictBanner pageId={pageId} />
      <SignedOutBanner />
      <HistoryViewingBar />
      <AgentReviewBar />
      {readOnly && (
        <div
          className="border-b border-border bg-muted px-4 py-2 text-sm text-foreground"
          role="status"
          data-testid="archived-banner"
        >
          This page is archived, so it opens read-only: nothing here can be
          changed.
        </div>
      )}
      {/* Below md (phones) the layers hide and the side panel stacks under the canvas, full width. */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="hidden w-64 shrink-0 border-r border-border bg-card md:block">
          <LayersPanel
            onAdd={() => setPaletteAt(defaultInsertAt(doc, selectedKey))}
            onNotice={notice}
          />
        </aside>
        <main
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/40 p-4"
          data-testid="canvas-area"
        >
          <CanvasFrame
            width={width}
            onSelect={(s) =>
              !(viewingDoc || agentDoc) && store.select(s?.key ?? null)
            }
            onKeyDown={onKeyDown}
          >
            <EditModeContext.Provider value={editMode}>
              <div
                className="min-h-screen overflow-x-hidden bg-background font-sans text-foreground"
                data-testid="canvas-page"
              >
                <CmsRenderContext.Provider value={renderData}>
                  {isPost && canvasDoc.post ? (
                    // Reading time as the server will store it on save (the local draft keeps the last saved value).
                    <PostLayout
                      doc={canvasDoc}
                      // biome-ignore lint/style/noNonNullAssertion: `canvasDoc.post` is checked above; withReadingTime keeps it.
                      post={withReadingTime(canvasDoc).post!}
                    >
                      <PageRenderer doc={canvasDoc} />
                    </PostLayout>
                  ) : (
                    <PageRenderer doc={canvasDoc} />
                  )}
                </CmsRenderContext.Provider>
              </div>
              {viewingDoc ? (
                <HistoryCanvasMarks />
              ) : agentDoc ? (
                <AgentCanvasMarks draft={doc} proposed={agentDoc} />
              ) : (
                <CanvasTools onInsert={setPaletteAt} onNotice={notice} />
              )}
            </EditModeContext.Provider>
          </CanvasFrame>
        </main>
        <aside
          className={`flex h-1/2 w-full shrink-0 flex-col border-t border-border bg-card md:h-auto md:border-t-0 md:border-l ${sideTab === "inspector" ? "md:w-80" : "md:w-96"}`}
        >
          <div
            className="flex shrink-0 border-b border-border text-sm"
            role="tablist"
          >
            {sideTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={sideTab === tab}
                data-testid={`side-tab-${tab}`}
                onClick={() => setSideTab(tab)}
                className={`flex-1 whitespace-nowrap px-2 py-2 [overflow-wrap:normal] ${sideTab === tab ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {SIDE_TAB_LABELS[tab]}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {sideTab === "ai" ? (
              <AgentPanel device={device} onOpenSeo={() => setSideTab("seo")} />
            ) : sideTab === "history" ? (
              <HistoryPanel />
            ) : sideTab === "seo" ? (
              <SeoPanel page={page} pageId={pageId} />
            ) : sideTab === "post" && isPost ? (
              <PostPanel />
            ) : (
              <Inspector device={device} />
            )}
          </div>
        </aside>
      </div>
      <BlockPalette
        open={paletteAt !== null}
        onOpenChange={(open) => !open && setPaletteAt(null)}
        onPick={insert}
        types={isPost ? POST_BLOCK_TYPES : undefined}
      />
    </div>
  );
}

type SideTab = "inspector" | "post" | "seo" | "history" | "ai";

const SIDE_TAB_LABELS: Record<SideTab, string> = {
  inspector: "Inspector",
  post: "Post",
  seo: "SEO",
  history: "History",
  ai: "AI",
};

/** The published posts, for `postList` blocks on the canvas (loaded once; none until then or on failure). */
function usePublishedPosts(): CmsRenderData {
  const [data, setData] = useState<CmsRenderData>({});
  useEffect(() => {
    let cancelled = false;
    getTrpc()
      .cms.posts.publishedPosts.query()
      .then((res) => !cancelled && res.ok && setData({ posts: res.posts }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

/** Rich text inside the selected block, edited in place with TipTap. */
function CanvasRichText({
  blockKey,
  path,
  doc,
  className,
  variant,
}: RichTextSlotArgs) {
  const store = useEditorStore();
  const registerFlusher = useCallback(
    (fn: () => void) => store.registerFlusher(fn),
    [store]
  );
  const onChange = (next: RichTextDoc) => {
    const block = store
      .getSnapshot()
      .doc.blocks.find((b) => b._key === blockKey);
    const at = block && indexPath(block.props, path);
    if (!(block && at)) {
      return;
    }
    const res = store.apply([
      { op: "update", key: blockKey, props: propsPatch(block.props, at, next) },
    ]);
    if (!res.ok) {
      notice(res.errors[0]?.message ?? "That text can't be saved");
    }
  };
  return (
    <RichTextEditor
      value={doc}
      onChange={onChange}
      onInvalid={(message) => message && richTextNotice(message)}
      registerFlusher={registerFlusher}
      className={className}
      toolbar="bubble"
      variant={variant}
      data-testid="canvas-rich-text"
    />
  );
}

/** `["items", "a1", "body"]` (list items by `_key`) → `["items", 0, "body"]`. */
function indexPath(props: unknown, path: string[]): Path | null {
  const out: Path = [];
  for (const segment of path) {
    const here = getIn(props, out);
    if (Array.isArray(here)) {
      const i = here.findIndex(
        (item) => (item as { _key?: unknown })?._key === segment
      );
      if (i < 0) {
        return null;
      }
      out.push(i);
    } else {
      out.push(segment);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Top bar

const DEVICES: { id: Device; label: string; Icon: typeof Monitor }[] = [
  { id: "desktop", label: "Desktop", Icon: Monitor },
  { id: "tablet", label: "Tablet", Icon: Tablet },
  { id: "mobile", label: "Mobile", Icon: Smartphone },
];

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved",
  saving: "Saving…",
  conflict: "Conflict — reload",
  rejected: "Not saved — reload",
  "signed-out": "Signed out — not saved",
  error: "Save failed — retrying",
};

function TopBar({
  page,
  width,
  setWidth,
  device,
}: {
  page: EditorPage["page"];
  width: number;
  setWidth: (w: number) => void;
  device: Device;
}) {
  const store = useEditorStore();
  const {
    status,
    canUndo,
    canRedo,
    publishing,
    pageStatus,
    hasUnpublishedChanges,
    doc,
  } = useEditorState();
  const path = slugToPath(doc.seo.slug);
  const [publishOpen, setPublishOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const seoWarnings = usePublishSeoWarnings(page, doc, publishOpen);
  const [previewing, setPreviewing] = useState(false);

  /** Saves pending edits, then opens the draft on its public URL through a 24-hour preview link. */
  const preview = async () => {
    // Opened now, inside the click, so popup blockers allow it; pointed at the link once it exists.
    const tab = window.open("about:blank", "_blank");
    if (tab) {
      tab.opener = null;
    }
    setPreviewing(true);
    try {
      const res = await store.whenSaved(() =>
        signedOutAsResult(() =>
          getTrpc().cms.preview.createPreviewLink.mutate({ pageId: page.id })
        )
      );
      if (!res?.ok) {
        tab?.close();
        return notice(
          res
            ? `No preview: ${res.message}`
            : "The draft couldn't be saved, so there's nothing new to preview."
        );
      }
      if (tab) {
        tab.location.href = res.url;
      } else {
        window.open(res.url, "_blank", "noopener");
      }
      const link = `${window.location.origin}${res.url}`;
      toast("Preview opened", {
        description: (
          <span>
            Anyone with{" "}
            <a
              className="underline"
              data-testid="preview-link"
              href={res.url}
              rel="noreferrer"
              target="_blank"
            >
              this link
            </a>{" "}
            sees the saved draft until{" "}
            {new Date(res.expiresAt).toLocaleString()}.{" "}
            <button
              className="underline"
              onClick={() => void navigator.clipboard?.writeText(link)}
              type="button"
            >
              Copy link
            </button>
          </span>
        ),
      });
    } catch (err) {
      tab?.close();
      notice(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  /**
   * From the publish dialog: true when the page was published. `expectedLiveRevId` is the live
   * revision the dialog compared against (undefined when it couldn't load it).
   */
  const publish = async (
    expectedLiveRevId: string | null | undefined
  ): Promise<boolean> => {
    const res = await store.publish(
      expectedLiveRevId === undefined ? undefined : { expectedLiveRevId }
    );
    if (!res) {
      notice("The draft couldn't be saved, so nothing was published.");
      return false;
    }
    if (!res.ok) {
      notice(`Not published: ${res.message}`);
      return false;
    }
    toast(res.live ? "Published" : "Published, but not live yet", {
      description: res.live ? (
        <a
          className="underline"
          data-testid="published-link"
          href={res.path}
          rel="noreferrer"
          target="_blank"
        >
          View {res.path}
        </a>
      ) : (
        "The site's page store didn't update. Publish again to retry."
      ),
    });
    return true;
  };

  const badge =
    pageStatus === "published"
      ? hasUnpublishedChanges
        ? {
            text: "Published · changes",
            cls: "bg-amber-500/15 text-amber-700 dark:text-amber-700 dark:text-amber-300",
          }
        : {
            text: "Published",
            cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-700 dark:text-emerald-300",
          }
      : pageStatus === "archived"
        ? { text: "Archived", cls: "bg-muted text-muted-foreground" }
        : { text: "Draft", cls: "bg-accent text-foreground" };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 overflow-x-auto border-b max-md:[&>*]:shrink-0 border-border bg-card px-3 text-sm">
      <Link
        to={page.kind === "post" ? "/admin/posts" : "/admin/pages"}
        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={page.kind === "post" ? "Back to posts" : "Back to pages"}
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <div className="min-w-0">
        <div className="truncate font-semibold" data-testid="page-title">
          {page.title}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {path}
        </div>
      </div>
      <span
        className={`rounded px-2 py-0.5 text-xs ${badge.cls}`}
        data-testid="publish-badge"
      >
        {badge.text}
      </span>

      <div className="mx-auto flex items-center gap-2">
        <div className="flex rounded border border-border p-0.5">
          {DEVICES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={`${label} (${DEVICE_PRESETS[id].width}px)`}
              aria-label={label}
              aria-pressed={width === DEVICE_PRESETS[id].width}
              data-testid={`device-${id}`}
              onClick={() => setWidth(DEVICE_PRESETS[id].width)}
              className={`rounded p-1.5 ${
                width === DEVICE_PRESETS[id].width
                  ? "bg-accent text-black"
                  : device === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
        <input
          type="range"
          min={320}
          max={1920}
          step={10}
          value={width}
          aria-label="Canvas width"
          data-testid="width-slider"
          onChange={(e) => setWidth(Number(e.target.value))}
          className="w-28 accent-primary"
        />
        <span
          className="w-14 font-mono text-xs text-muted-foreground"
          data-testid="canvas-width"
        >
          {width}px
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Undo"
          title="Undo (Ctrl/Cmd+Z)"
          disabled={!canUndo}
          data-testid="undo"
          onClick={() => store.undo()}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          disabled={!canRedo}
          data-testid="redo"
          onClick={() => store.redo()}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
        >
          <Redo2 className="h-4 w-4" />
        </button>
      </div>
      <span
        data-testid="save-status"
        data-status={status}
        className={`w-40 text-right text-xs ${
          status === "conflict" ||
          status === "rejected" ||
          status === "signed-out" ||
          status === "error"
            ? "text-destructive"
            : "text-muted-foreground"
        }`}
      >
        {STATUS_TEXT[status]}
      </span>
      <SaveVersionButton />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void preview()}
        disabled={
          previewing ||
          status === "conflict" ||
          status === "rejected" ||
          status === "signed-out" ||
          pageStatus === "archived"
        }
        title="Save, then open the draft through a 24-hour preview link"
        data-testid="preview"
      >
        <Eye className="h-4 w-4" aria-hidden />{" "}
        {previewing ? "Opening…" : "Preview"}
      </Button>
      <Button
        size="sm"
        onClick={() => setPublishOpen(true)}
        disabled={
          publishing ||
          status === "conflict" ||
          status === "rejected" ||
          status === "signed-out" ||
          pageStatus === "archived"
        }
        data-testid="publish"
      >
        {publishing ? "Publishing…" : "Publish"}
      </Button>
      {pageStatus === "published" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setUnpublishOpen(true)}
          disabled={publishing || status === "signed-out"}
          title="Take this off the site; the draft stays"
          data-testid="unpublish"
        >
          Unpublish
        </Button>
      )}
      <UnpublishDialog
        target={unpublishOpen ? { id: page.id, kind: page.kind, path } : null}
        onClose={() => setUnpublishOpen(false)}
        onDone={() => store.unpublished()}
      />
      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        pageId={page.id}
        warnings={seoWarnings}
        onPublish={publish}
      />
    </header>
  );
}

/** The session ended mid-edit: edits stay queued here; sign in elsewhere, then Retry resends them. */
function SignedOutBanner() {
  const store = useEditorStore();
  const { status } = useEditorState();
  if (status !== "signed-out") {
    return null;
  }
  return (
    <div
      className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-foreground"
      role="alert"
      data-testid="signed-out-banner"
    >
      <span>
        You were signed out —{" "}
        <a
          href="/login"
          target="_blank"
          rel="noreferrer"
          className="underline"
          data-testid="sign-in-link"
        >
          sign in in a new tab
        </a>
        , then click Retry. Your edits are kept in this tab until they save.
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void store.retry()}
        data-testid="retry-save"
      >
        Retry
      </Button>
    </div>
  );
}

function ConflictBanner({ pageId }: { pageId: string }) {
  const store = useEditorStore();
  const { status, error } = useEditorState();
  const [loading, setLoading] = useState(false);
  if (status !== "conflict" && status !== "rejected") {
    return null;
  }
  const reload = async () => {
    setLoading(true);
    try {
      const res = await signedOutAsResult(() =>
        getTrpc().cms.pages.getEditorPage.query({ id: pageId })
      );
      if (!res.ok) {
        return notice(res.message);
      }
      store.reset(initFrom(editorPageFromWire(res)));
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div
      className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/15 px-4 py-2 text-sm text-foreground"
      role="alert"
      data-testid="conflict-banner"
    >
      <span>
        {status === "conflict"
          ? "This draft was changed somewhere else (another tab or person), so your latest edits weren't saved."
          : `Your latest edits couldn't be saved: ${error ?? "the server refused them"}.`}{" "}
        Reload the draft to keep editing; unsaved edits are discarded.
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={reload}
        disabled={loading}
        data-testid="reload-draft"
      >
        {loading ? "Reloading…" : "Reload draft"}
      </Button>
    </div>
  );
}
