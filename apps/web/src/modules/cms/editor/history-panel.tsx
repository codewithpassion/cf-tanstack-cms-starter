// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered requests or test steps), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/noParameterProperties: ported verbatim; constructor parameter properties as in the source.
// biome-ignore-all lint/style/useReadonlyClassProperties: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noArrayIndexKey: word-diff parts carry no ids and never reorder.
// biome-ignore-all lint/suspicious/noLeakedRender: flagged on `{busy ? "Saving…" : action}`, where `action` is a string label.
// biome-ignore-all lint/suspicious/noRedeclare: `Dialog` the type and `Dialog` the component name different things; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning interfaces and callbacks; kept as in the source.

import {
  type AdminResult,
  type EditorPageWire,
  editorPageFromWire,
  type RevisionListItem,
} from "@repo/cms-core/admin-result";
import { isRunId } from "@repo/cms-core/agent/run";
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import {
  type BlockChange,
  type DocDiff,
  diffDocs,
  type FieldChange,
  fieldLabel,
  isColor,
  isRichText,
  richTextToPlain,
  type WordPart,
} from "@repo/cms-core/editor/diff";
import { parseMcpAuthor } from "@repo/cms-core/mcp/author";
import { deepEqual } from "@repo/cms-core/ops/json";
import { withReadingTime } from "@repo/cms-core/posts";
import type { PageDoc } from "@repo/cms-core/types";
import { Loader2, Pencil, Pin, PinOff, RotateCcw } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { getTrpc } from "#/integrations/trpc/client";
import { useCanvas } from "./canvas-frame";
import { signedOutAsResult } from "./signed-out";
import type { EditorInit, EditorStore } from "./store";
import { useEditorState } from "./use-editor-store";

/**
 * The History tab (docs/cms-plan.md §3.2): a timeline of the page's revisions grouped by day;
 * selecting one shows it read-only on the canvas (the draft is locked meanwhile), optionally
 * diffed against the draft, the previous version or any other version; restore the whole version
 * or one block, roll the live page back to a published version, save / rename / pin versions.
 *
 * State lives in `HistoryView` (one per editor, provided by `HistoryViewContext`), so the canvas
 * (page-editor.tsx), the top bar and the panel share it. Everything that touches the draft rides
 * the editor store's save chain (`EditorStore.whenSaved`), and a restore or rollback reloads the
 * draft from the server's answer, which clears undo history.
 */

// ---------------------------------------------------------------------------------------------
// State

export type CompareMode = "off" | "draft" | "previous" | "other";

type Dialog =
  | { kind: "save" }
  | { kind: "restore"; rev: RevisionListItem }
  | { kind: "rollback"; rev: RevisionListItem }
  | { kind: "rename"; rev: RevisionListItem };

export type HistoryState = {
  entries: RevisionListItem[];
  pinned: RevisionListItem[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  /** The version on the canvas instead of the draft. */
  viewing: { rev: RevisionListItem; doc: PageDoc } | null;
  /** Revision being fetched to view. */
  opening: string | null;
  compare: CompareMode;
  /** With compare "other": the version to compare with. */
  otherRevId: string | null;
  /** The comparison's base document for "previous" / "other" (null while loading). */
  base: PageDoc | null;
  busy: boolean;
  dialog: Dialog | null;
  /** Scroll the canvas to this block (n changes on every request). */
  focus: { key: string; n: number } | null;
};

const LOCK =
  'You are looking at an older version. Click "Back to draft" to edit.';

const notice = (message: string) => toast.error(message);
const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export class HistoryView {
  private state: HistoryState = {
    entries: [],
    pinned: [],
    nextCursor: null,
    loading: false,
    error: null,
    viewing: null,
    opening: null,
    compare: "draft",
    otherRevId: null,
    base: null,
    busy: false,
    dialog: null,
    focus: null,
  };
  private listeners = new Set<() => void>();
  private docs = new Map<string, PageDoc>();
  private listRequest = 0;

  constructor(
    private readonly store: EditorStore,
    private readonly pageId: string
  ) {}

  getState = (): HistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<HistoryState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) {
      l();
    }
  }

  // --- List ----------------------------------------------------------------------------------

  /**
   * Reloads the newest entries. Older pages loaded before stay (everything past the first page is
   * older than it), and so does the cursor to the next one.
   */
  async refresh(): Promise<void> {
    const request = ++this.listRequest;
    this.set({ loading: true });
    const res = await this.rpc(() =>
      getTrpc().cms.pages.listRevisions.query({ pageId: this.pageId })
    );
    if (request !== this.listRequest) {
      return;
    }
    if (!res?.ok) {
      return this.set({
        loading: false,
        error: res?.message ?? "History couldn't be loaded.",
      });
    }
    const fresh = new Set(res.revisions.map((r) => r.id));
    const older = this.state.entries.filter((r) => !fresh.has(r.id));
    const { viewing } = this.state;
    const current =
      viewing &&
      [...res.revisions, ...res.pinned, ...older].find(
        (r) => r.id === viewing.rev.id
      );
    this.set({
      entries: [...res.revisions, ...older],
      pinned: res.pinned,
      nextCursor: older.length ? this.state.nextCursor : res.nextCursor,
      loading: false,
      error: null,
      ...(current && viewing && { viewing: { ...viewing, rev: current } }),
    });
  }

  /** Applies a rename or pin the server accepted to every loaded copy of the entry. */
  private patchEntry(id: string, patch: Partial<RevisionListItem>) {
    const apply = (r: RevisionListItem) =>
      r.id === id ? { ...r, ...patch } : r;
    const { viewing } = this.state;
    this.set({
      entries: this.state.entries.map(apply),
      pinned: this.state.pinned.map(apply),
      ...(viewing?.rev.id === id && {
        viewing: { ...viewing, rev: apply(viewing.rev) },
      }),
    });
  }

  async loadMore(): Promise<void> {
    const cursor = this.state.nextCursor;
    if (!cursor) {
      return;
    }
    const request = ++this.listRequest;
    this.set({ loading: true });
    const res = await this.rpc(() =>
      getTrpc().cms.pages.listRevisions.query({ pageId: this.pageId, cursor })
    );
    if (request !== this.listRequest) {
      return;
    }
    if (!res?.ok) {
      return this.set({
        loading: false,
        error: res?.message ?? "History couldn't be loaded.",
      });
    }
    // Entries appended since the first page shift the offset: drop the repeats.
    const seen = new Set(this.state.entries.map((r) => r.id));
    this.set({
      entries: [
        ...this.state.entries,
        ...res.revisions.filter((r) => !seen.has(r.id)),
      ],
      nextCursor: res.nextCursor,
      loading: false,
    });
  }

  // --- Viewing and comparing -----------------------------------------------------------------

  async view(rev: RevisionListItem): Promise<void> {
    if (this.state.viewing?.rev.id === rev.id) {
      return;
    }
    this.set({ opening: rev.id });
    const doc = await this.doc(rev.id);
    if (this.state.opening !== rev.id) {
      return; // another entry was picked meanwhile
    }
    if (!doc) {
      return this.set({ opening: null });
    }
    // Pending typing (a rich-text debounce, an inline field) lands in the draft before the lock refuses edits.
    this.store.flushEdits();
    this.store.lock(LOCK);
    const compare =
      this.state.compare === "other" ? "draft" : this.state.compare;
    this.set({
      viewing: { rev, doc },
      opening: null,
      compare,
      otherRevId: null,
      base: null,
    });
    await this.loadBase();
  }

  backToDraft() {
    this.store.lock(null);
    this.set({
      viewing: null,
      opening: null,
      base: null,
      otherRevId: null,
      compare: this.state.compare === "other" ? "draft" : this.state.compare,
    });
  }

  async setCompare(
    mode: CompareMode,
    otherRevId: string | null = null
  ): Promise<void> {
    this.set({
      compare: mode,
      otherRevId: mode === "other" ? otherRevId : null,
      base: null,
    });
    await this.loadBase();
  }

  focusBlock(key: string) {
    this.set({ focus: { key, n: (this.state.focus?.n ?? 0) + 1 } });
  }

  /** Every entry loaded so far (pinned ones may be older than the list). */
  find(id: string): RevisionListItem | undefined {
    return (
      this.state.entries.find((r) => r.id === id) ??
      this.state.pinned.find((r) => r.id === id)
    );
  }

  private async loadBase() {
    const { viewing, compare, otherRevId } = this.state;
    if (!viewing || (compare !== "previous" && compare !== "other")) {
      return;
    }
    const baseRev =
      compare === "other"
        ? otherRevId
          ? (this.find(otherRevId) ?? null)
          : null
        : await this.previousOf(viewing.rev);
    // The page's first version: compared with nothing, every block is new.
    const doc = baseRev
      ? await this.doc(baseRev.id)
      : { ...viewing.doc, blocks: [] };
    const now = this.state;
    if (
      now.viewing?.rev.id !== viewing.rev.id ||
      now.compare !== compare ||
      now.otherRevId !== otherRevId
    ) {
      return;
    }
    this.set({ base: doc });
  }

  /** The entry just older than `rev`, loading older pages as needed. */
  private async previousOf(
    rev: RevisionListItem
  ): Promise<RevisionListItem | null> {
    for (;;) {
      const { entries, nextCursor } = this.state;
      const i = entries.findIndex((r) => r.id === rev.id);
      if (i >= 0 && i < entries.length - 1) {
        return entries[i + 1]!;
      }
      if (!nextCursor) {
        return null;
      }
      await this.loadMore();
      if (this.state.nextCursor === nextCursor) {
        return null; // the page failed to load
      }
    }
  }

  private async doc(revId: string): Promise<PageDoc | null> {
    const cached = this.docs.get(revId);
    if (cached) {
      return cached;
    }
    const res = await this.rpc(() =>
      getTrpc().cms.pages.getRevision.query({ pageId: this.pageId, revId })
    );
    if (!res) {
      return null;
    }
    if (!res.ok) {
      notice(`That version couldn't be opened: ${res.message}`);
      return null;
    }
    const doc = JSON.parse(res.docJson) as PageDoc;
    this.docs.set(revId, doc);
    return doc;
  }

  // --- Actions -------------------------------------------------------------------------------

  openDialog(dialog: Dialog | null) {
    if (
      dialog?.kind === "save" &&
      this.store.getSnapshot().pageStatus === "archived"
    ) {
      return;
    }
    this.set({ dialog });
  }

  /** A named version of the draft as it is now (pending edits are saved first). */
  async saveVersion(label: string): Promise<boolean> {
    return this.act(async () => {
      const res = await this.store.whenSaved((draftVersion) =>
        this.rpcResult(() =>
          getTrpc().cms.pages.saveNamedVersion.mutate({
            pageId: this.pageId,
            label,
            draftVersion,
          })
        )
      );
      if (!res) {
        return fail(
          "The draft couldn't be saved first, so no version was made."
        );
      }
      if (!res.ok) {
        return fail(`Version not saved: ${res.message}`);
      }
      toast(`Saved version "${label.trim()}"`);
      return true;
    });
  }

  /** The viewed version becomes the draft (a new "Restored" entry; nothing is removed). */
  async restore(rev: RevisionListItem): Promise<boolean> {
    return this.act(async () => {
      const res = await this.store.whenSaved(
        (draftVersion) =>
          this.rpcResult(() =>
            getTrpc().cms.pages.restoreRevision.mutate({
              pageId: this.pageId,
              revId: rev.id,
              draftVersion,
            })
          ),
        { replace: (r) => initOf(r.editor) }
      );
      if (!res) {
        return fail(
          "The draft couldn't be saved first, so nothing was restored."
        );
      }
      if (!res.ok) {
        return fail(`Not restored: ${res.message}`);
      }
      this.backToDraft();
      const leftOut = [
        ...(res.dropped.length
          ? [
              `Left out, no longer valid: ${res.dropped.map((b) => b.label).join(", ")}.`,
            ]
          : []),
        ...(res.seoReplaced.length
          ? [
              `Kept the draft's SEO ${res.seoReplaced.join(", ")} (the version's is no longer valid).`,
            ]
          : []),
      ];
      (leftOut.length > 0 ? toast.error : toast)(
        `Restored ${entryTitle(rev)}`,
        {
          description: [
            ...leftOut,
            "The draft before it is kept in History.",
          ].join(" "),
        }
      );
      return true;
    });
  }

  /** Copies one block of the viewed version into the draft; the rest of the draft is unchanged. */
  async restoreBlock(
    rev: RevisionListItem,
    blockKey: string,
    label: string
  ): Promise<boolean> {
    return this.act(async () => {
      const res = await this.store.whenSaved(
        (draftVersion) =>
          this.rpcResult(() =>
            getTrpc().cms.pages.restoreBlockFromRevision.mutate({
              pageId: this.pageId,
              revId: rev.id,
              blockKey,
              draftVersion,
            })
          ),
        { replace: (r) => initOf(r.editor) }
      );
      if (!res) {
        return fail(
          "The draft couldn't be saved first, so the block wasn't restored."
        );
      }
      if (!res.ok) {
        return fail(`Block not restored: ${res.message}`);
      }
      toast(`Restored ${label} into the draft`);
      return true;
    });
  }

  /**
   * Publishes a published version again. Independent of the draft: it doesn't wait for saves, and
   * the draft, its pending edits and undo history stay as they are.
   */
  async rollback(rev: RevisionListItem): Promise<boolean> {
    return this.act(async () => {
      const res = await this.rpc(() =>
        getTrpc().cms.pages.rollbackLive.mutate({
          pageId: this.pageId,
          revId: rev.id,
        })
      );
      if (!res) {
        return false;
      }
      if (!res.ok) {
        return fail(`Not rolled back: ${res.message}`);
      }
      this.store.liveChanged(res.editor.hasUnpublishedChanges);
      toast(
        res.live ? "Live page rolled back" : "Rolled back, but not live yet",
        {
          description: res.live ? (
            <a
              href={res.path}
              target="_blank"
              rel="noreferrer"
              className="underline"
              data-testid="rollback-link"
            >
              View {res.path}
            </a>
          ) : (
            "The site's page store didn't update. Publish again to retry."
          ),
        }
      );
      return true;
    });
  }

  async rename(rev: RevisionListItem, label: string): Promise<boolean> {
    return this.act(async () => {
      const res = await this.rpc(() =>
        getTrpc().cms.pages.labelRevision.mutate({
          pageId: this.pageId,
          revId: rev.id,
          label,
        })
      );
      if (!res) {
        return false;
      }
      if (!res.ok) {
        return fail(`Not renamed: ${res.message}`);
      }
      // An empty name goes back to the original one, which only the refresh knows.
      if (label.trim()) {
        this.patchEntry(rev.id, { label: label.trim() });
      }
      return true;
    });
  }

  async pin(rev: RevisionListItem, pinned: boolean): Promise<boolean> {
    return this.act(async () => {
      const res = await this.rpc(() =>
        getTrpc().cms.pages.labelRevision.mutate({
          pageId: this.pageId,
          revId: rev.id,
          pinned,
        })
      );
      if (!res) {
        return false;
      }
      if (!res.ok) {
        return fail(`Not ${pinned ? "pinned" : "unpinned"}: ${res.message}`);
      }
      this.patchEntry(rev.id, { pinned });
      return true;
    });
  }

  /** Runs one action at a time; closes the dialog and refreshes the list afterwards. */
  private async act(fn: () => Promise<boolean>): Promise<boolean> {
    if (this.state.busy) {
      return false;
    }
    this.set({ busy: true });
    try {
      return await fn();
    } catch (err) {
      notice(errorText(err));
      return false;
    } finally {
      this.set({ busy: false, dialog: null });
      void this.refresh();
    }
  }

  /** A server call; a signed-out failure becomes `SIGNED_OUT`. */
  private rpcResult<T extends object>(
    call: () => Promise<AdminResult<T>>
  ): Promise<AdminResult<T>> {
    return signedOutAsResult(call);
  }

  /** Like `rpcResult`, but a thrown error (network) is shown and resolves null. */
  private async rpc<T extends object>(
    call: () => Promise<AdminResult<T>>
  ): Promise<AdminResult<T> | null> {
    try {
      return await signedOutAsResult(call);
    } catch (err) {
      notice(errorText(err));
      return null;
    }
  }
}

function fail(message: string): false {
  notice(message);
  return false;
}

export function initOf(wire: EditorPageWire): EditorInit {
  const page = editorPageFromWire(wire);
  return {
    doc: page.draftDoc,
    draftVersion: page.draftVersion,
    pageStatus: page.page.status,
    hasUnpublishedChanges: page.hasUnpublishedChanges,
  };
}

export const HistoryViewContext = createContext<HistoryView | null>(null);

export function useHistoryView(): HistoryView {
  const view = useContext(HistoryViewContext);
  if (!view) {
    throw new Error("useHistoryView must be used inside the page editor");
  }
  return view;
}

export function useHistoryState(): HistoryState {
  const view = useHistoryView();
  return useSyncExternalStore(view.subscribe, view.getState, view.getState);
}

/** The version on the canvas instead of the draft, or null. */
export function useViewingDoc(): PageDoc | null {
  return useHistoryState().viewing?.doc ?? null;
}

/**
 * The active comparison: always `base → viewed version`, so additions and changes are on the
 * canvas. Base is the draft, the previous version, or the picked one.
 */
export function useHistoryDiff(): DocDiff | null {
  const { viewing, compare, base } = useHistoryState();
  const { doc: draft } = useEditorState();
  return useMemo(() => {
    if (!viewing || compare === "off") {
      return null;
    }
    // The editor's copy of a post's reading time may lag the server's (computed on save).
    const from = compare === "draft" ? withReadingTime(draft) : base;
    return from ? diffDocs(from, viewing.doc) : null;
  }, [viewing, compare, base, draft]);
}

// ---------------------------------------------------------------------------------------------
// Labels

const KIND_TITLE: Record<RevisionListItem["kind"], string> = {
  autosnapshot: "Autosnapshot",
  named: "Named version",
  published: "Published",
  agent: "Agent change",
  restore: "Restored",
};

export function entryTitle(rev: RevisionListItem): string {
  return rev.label
    ? `"${rev.label}"`
    : `${KIND_TITLE[rev.kind].toLowerCase()} from ${dateTime(rev.createdAt)}`;
}

const blockLabel = (type: string) => getBlockDef(type)?.label ?? type;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function dateTime(iso: string) {
  return dateTimeFormat.format(new Date(iso));
}

function dayLabel(iso: string, now: number): string {
  const day = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(day, today)) {
    return "Today";
  }
  if (same(day, yesterday)) {
    return "Yesterday";
  }
  return dayFormat.format(day);
}

export function relativeTime(iso: string, now: number): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) {
    return "just now";
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ago`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)} h ago`;
  }
  const days = Math.floor(s / 86_400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------------------------------------
// Panel

/** The History tab's content. Leaving the tab goes back to the draft. */
export function HistoryPanel() {
  const view = useHistoryView();
  const state = useHistoryState();
  const { draftVersion, pageStatus, hasUnpublishedChanges, publishing } =
    useEditorState();
  const first = useRef(true);

  // Saves can write autosnapshots and publishing adds an entry: refresh after either settles.
  useEffect(() => {
    const delay = first.current ? 0 : 800;
    first.current = false;
    const t = setTimeout(() => void view.refresh(), delay);
    return () => clearTimeout(t);
  }, [view, draftVersion, pageStatus, hasUnpublishedChanges, publishing]);

  useEffect(() => () => view.backToDraft(), [view]);

  return (
    <div
      className="flex h-full min-h-0 flex-col text-sm"
      data-testid="history-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="font-semibold">History</h2>
        {!!state.loading && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-label="Loading"
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7"
          disabled={pageStatus === "archived"}
          title="Save version… (Ctrl/Cmd+Shift+S)"
          onClick={() => view.openDialog({ kind: "save" })}
          data-testid="history-save-version"
        >
          Save version…
        </Button>
      </div>
      {!!state.viewing && <VersionDetails />}
      <Timeline />
    </div>
  );
}

function Timeline() {
  const view = useHistoryView();
  const { entries, pinned, nextCursor, loading, error, viewing, opening } =
    useHistoryState();
  const { hasUnpublishedChanges, pageStatus } = useEditorState();
  const now = useNow();

  const groups: { day: string; items: RevisionListItem[] }[] = [];
  for (const rev of entries) {
    const day = dayLabel(rev.createdAt, now);
    if (groups.at(-1)?.day !== day) {
      groups.push({ day, items: [] });
    }
    groups.at(-1)!.items.push(rev);
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto pb-6"
      data-testid="history-timeline"
    >
      <button
        type="button"
        onClick={() => view.backToDraft()}
        data-testid="history-draft"
        aria-current={!viewing}
        className={`block w-full border-b border-border px-3 py-2 text-left ${viewing ? "hover:bg-muted/60" : "bg-accent/10"}`}
      >
        <div className="font-medium">Current draft</div>
        <div className="text-xs text-muted-foreground">
          {pageStatus === "published"
            ? hasUnpublishedChanges
              ? "Has unpublished changes"
              : "Same as the live page"
            : "Not published yet"}
        </div>
      </button>
      {!!error && (
        <p className="px-3 py-2 text-xs text-destructive" role="alert">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void view.refresh()}
          >
            Retry
          </button>
        </p>
      )}
      {pinned.length > 0 && (
        <Group title="Pinned">
          {pinned.map((rev) => (
            <Entry
              key={`pin-${rev.id}`}
              rev={rev}
              now={now}
              selected={viewing?.rev.id === rev.id}
              opening={opening === rev.id}
            />
          ))}
        </Group>
      )}
      {groups.map((g) => (
        <Group key={g.day} title={g.day}>
          {g.items.map((rev) => (
            <Entry
              key={rev.id}
              rev={rev}
              now={now}
              selected={viewing?.rev.id === rev.id}
              opening={opening === rev.id}
            />
          ))}
        </Group>
      ))}
      {!(loading || error) && entries.length === 0 && (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          No versions yet. They appear as you work: an autosnapshot when you
          come back after a break, and one for each publish, restore and saved
          version.
        </p>
      )}
      {!!nextCursor && (
        <div className="px-3 pt-3">
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            disabled={loading}
            onClick={() => void view.loadMore()}
            data-testid="history-more"
          >
            Older versions
          </Button>
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="sticky top-0 z-10 bg-card px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

function Entry({
  rev,
  now,
  selected,
  opening,
}: {
  rev: RevisionListItem;
  now: number;
  selected: boolean;
  opening: boolean;
}) {
  const view = useHistoryView();
  return (
    <li>
      <button
        type="button"
        onClick={() => void view.view(rev)}
        data-testid="history-entry"
        data-rev-id={rev.id}
        data-kind={rev.kind}
        aria-current={selected}
        className={`block w-full px-3 py-2 text-left ${selected ? "bg-accent/15 ring-1 ring-inset ring-primary/60" : "hover:bg-muted/60"}`}
      >
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">
            {rev.label ?? KIND_TITLE[rev.kind]}
          </span>
          {!!rev.pinned && (
            <Pin
              className="h-3 w-3 shrink-0 text-primary"
              aria-label="Pinned"
            />
          )}
          {!!opening && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span
            className="ml-auto shrink-0 text-xs text-muted-foreground"
            title={new Date(rev.createdAt).toLocaleString()}
          >
            {timeFormat.format(new Date(rev.createdAt))} ·{" "}
            {relativeTime(rev.createdAt, now)}
          </span>
        </div>
        <Badges rev={rev} />
        {!!rev.summary && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {rev.summary}
          </p>
        )}
      </button>
    </li>
  );
}

const BADGE =
  "rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide";

function Badges({ rev }: { rev: RevisionListItem }) {
  const badges: { text: string; cls: string; title?: string }[] = [];
  if (rev.kind === "published") {
    badges.push({
      text: "Published",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-700 dark:text-emerald-300",
    });
  }
  if (rev.isLive) {
    badges.push({ text: "Live", cls: "bg-emerald-400 text-black" });
  }
  if (rev.kind === "named") {
    badges.push({
      text: "Named",
      cls: "bg-accent/20 text-primary",
    });
  }
  if (rev.kind === "restore") {
    badges.push({ text: "Restored", cls: "bg-violet-500/25 text-violet-200" });
  }
  if (rev.kind === "autosnapshot") {
    badges.push({
      text: "Autosnapshot",
      cls: "bg-accent text-muted-foreground",
    });
  }
  if (rev.kind === "agent") {
    badges.push({
      text: "Agent",
      cls: "bg-primary-soft/25 text-primary-soft",
    });
  }
  if (isRunId(rev.agentRunId)) {
    badges.push({ text: "Site run", cls: "bg-violet-500/25 text-violet-200" });
  }
  if (rev.byYou) {
    badges.push({
      text: "You",
      cls: "border border-border text-muted-foreground",
    });
  }
  // Written over the MCP server (src/modules/cms/mcp): the author is "mcp:<key name>#<key prefix>".
  const mcp = parseMcpAuthor(rev.author);
  if (mcp) {
    badges.push({
      text: `MCP · ${mcp.name}`,
      cls: "border border-primary/50 text-primary",
      ...(mcp.prefix && { title: `API key ${mcp.prefix}` }),
    });
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="history-badges">
      {badges.map((b) => (
        <span key={b.text} className={`${BADGE} ${b.cls}`} title={b.title}>
          {b.text}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The selected version

function VersionDetails() {
  const view = useHistoryView();
  const state = useHistoryState();
  const { pageStatus, doc: draft } = useEditorState();
  const diff = useHistoryDiff();
  const viewing = state.viewing!;
  const { rev } = viewing;
  const archived = pageStatus === "archived";
  const others = [...state.pinned, ...state.entries].filter(
    (r, i, all) => r.id !== rev.id && all.findIndex((x) => x.id === r.id) === i
  );
  const compareValue =
    state.compare === "other" ? `rev:${state.otherRevId}` : state.compare;

  return (
    <div
      className="max-h-[62%] shrink-0 overflow-y-auto border-b border-border bg-background/60 px-3 py-3"
      data-testid="history-details"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">
            {rev.label ?? KIND_TITLE[rev.kind]}
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(rev.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <IconButton
            label="Rename"
            onClick={() => view.openDialog({ kind: "rename", rev })}
            testId="history-rename"
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label={rev.pinned ? "Unpin" : "Pin"}
            onClick={() => void view.pin(rev, !rev.pinned)}
            testId="history-pin"
          >
            {rev.pinned ? (
              <PinOff className="h-3.5 w-3.5" />
            ) : (
              <Pin className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </div>
      </div>
      <Badges rev={rev} />
      {!!rev.summary && (
        <p className="mt-2 text-xs text-muted-foreground">{rev.summary}</p>
      )}
      {isRunId(rev.agentRunId) && (
        <a
          href={`/admin/agent?run=${encodeURIComponent(rev.agentRunId)}`}
          className="mt-1 inline-block text-xs text-primary hover:underline"
          data-testid="history-run-link"
        >
          Part of a site-wide agent run: review or revert it
        </a>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => view.openDialog({ kind: "restore", rev })}
          disabled={state.busy || archived}
          data-testid="history-restore"
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Restore this version
        </Button>
        {rev.kind === "published" && (
          // The title sits on a wrapper: a disabled button shows no tooltip.
          <span
            title={
              pageStatus === "published"
                ? rev.isLive
                  ? "This is the live version"
                  : "Publish this version again; the draft is not changed"
                : "The page isn't published, so there's no live page to roll back. Publish it instead."
            }
            data-testid="history-rollback-wrap"
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() => view.openDialog({ kind: "rollback", rev })}
              disabled={
                state.busy ||
                archived ||
                rev.isLive ||
                pageStatus !== "published"
              }
              data-testid="history-rollback"
            >
              Roll back live
            </Button>
          </span>
        )}
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        Compare with
        <select
          value={compareValue}
          onChange={(e) => {
            const v = e.target.value;
            void (v.startsWith("rev:")
              ? view.setCompare("other", v.slice(4))
              : view.setCompare(v as CompareMode));
          }}
          className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-foreground"
          data-testid="history-compare"
        >
          <option value="off">Nothing (no highlights)</option>
          <option value="draft">The current draft</option>
          <option value="previous">The previous version</option>
          <optgroup label="Another version">
            {others.map((r) => (
              <option key={r.id} value={`rev:${r.id}`}>
                {r.label ?? KIND_TITLE[r.kind]} · {dateTime(r.createdAt)}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <DiffList
        diff={diff}
        mode={state.compare}
        viewing={viewing}
        draft={draft}
        disabled={state.busy || archived}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testId}
      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** Outline colours on the canvas, and the panel's dots. */
const MARK: Record<BlockChange["status"], { color: string; dot: string }> = {
  added: { color: "#22c55e", dot: "bg-green-500" },
  changed: { color: "#f59e0b", dot: "bg-amber-500" },
  moved: { color: "#60a5fa", dot: "bg-blue-400" },
  removed: { color: "#ef4444", dot: "bg-red-500" },
};

/** What each status means for the comparison (base → viewed version). */
function statusText(status: BlockChange["status"], mode: CompareMode): string {
  if (mode === "draft") {
    return {
      added: "Not in the draft",
      removed: "Only in the draft",
      changed: "Differs from the draft",
      moved: "In another place in the draft",
    }[status];
  }
  return {
    added: "Added",
    removed: "Removed",
    changed: "Changed",
    moved: "Moved",
  }[status];
}

function DiffList({
  diff,
  mode,
  viewing,
  draft,
  disabled,
}: {
  diff: DocDiff | null;
  mode: CompareMode;
  viewing: NonNullable<HistoryState["viewing"]>;
  draft: PageDoc;
  disabled: boolean;
}) {
  const view = useHistoryView();
  const draftByKey = new Map(draft.blocks.map((b) => [b._key, b]));
  // Restorable: the block is in this version and the draft's copy differs (or is gone).
  const restorable = (key: string) => {
    const inVersion = viewing.doc.blocks.find((b) => b._key === key);
    return !!inVersion && !deepEqual(draftByKey.get(key), inVersion);
  };
  const restoreButton = (key: string, label: string) => (
    <button
      type="button"
      className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-foreground hover:border-primary disabled:opacity-40"
      disabled={disabled}
      onClick={() => void view.restoreBlock(viewing.rev, key, label)}
      data-testid="history-restore-block"
    >
      Restore just this block
    </button>
  );
  // Compared with something other than the draft (or nothing): blocks that differ from the draft
  // but aren't listed as changes can still be restored.
  const listed = new Set(
    mode === "off" || !diff ? [] : diff.blocks.map((c) => c.key)
  );
  const alsoDiffers =
    mode === "draft"
      ? []
      : viewing.doc.blocks.filter(
          (b) => !listed.has(b._key) && restorable(b._key)
        );
  const others = alsoDiffers.length > 0 && (
    <div className="flex flex-col gap-2" data-testid="history-draft-differs">
      <div className="text-xs text-muted-foreground">
        {mode === "off"
          ? "Blocks that differ from the draft"
          : "Also differ from the draft"}
      </div>
      {alsoDiffers.map((b) => {
        const label = blockLabel(b._type);
        return (
          <div
            key={b._key}
            className="flex items-center gap-2 rounded border border-border p-2"
            data-testid="history-diff-block"
            data-status="draft"
            data-key={b._key}
          >
            <button
              type="button"
              className="min-w-0 truncate text-left font-medium hover:underline"
              title="Show on the canvas"
              onClick={() => view.focusBlock(b._key)}
            >
              {label}
            </button>
            <span className="shrink-0 text-xs text-muted-foreground">
              Differs from the draft
            </span>
            {restoreButton(b._key, label)}
          </div>
        );
      })}
    </div>
  );
  if (mode === "off") {
    return others ? (
      <div className="mt-3 flex flex-col gap-2">{others}</div>
    ) : null;
  }
  if (!diff) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Loading the comparison…
      </p>
    );
  }
  if (!diff.changed) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p
          className="text-xs text-muted-foreground"
          data-testid="history-diff-empty"
        >
          {mode === "draft"
            ? "This version is the same as the draft."
            : "No differences."}
        </p>
        {others}
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="history-diff">
      {diff.blocks.map((change) => {
        const label = blockLabel(change.type);
        return (
          <div
            key={change.key}
            className="rounded border border-border p-2"
            data-testid="history-diff-block"
            data-status={change.status}
            data-key={change.key}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${MARK[change.status].dot}`}
              />
              <button
                type="button"
                className="min-w-0 truncate text-left font-medium hover:underline disabled:no-underline"
                disabled={change.status === "removed"}
                title={
                  change.status === "removed"
                    ? "Not in this version, so not on the canvas"
                    : "Show on the canvas"
                }
                onClick={() => view.focusBlock(change.key)}
              >
                {label}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground">
                {statusText(change.status, mode)}
                {change.status === "changed" && change.moved ? " · moved" : ""}
              </span>
              {restorable(change.key) && restoreButton(change.key, label)}
            </div>
            {change.status === "changed" && (
              <FieldList fields={change.fields} />
            )}
          </div>
        );
      })}
      {diff.seo.length > 0 && (
        <div className="rounded border border-border p-2">
          <div className="font-medium">SEO</div>
          <FieldList fields={diff.seo} />
        </div>
      )}
      {diff.post.length > 0 && (
        <div className="rounded border border-border p-2">
          <div className="font-medium">Post details</div>
          <FieldList fields={diff.post} />
        </div>
      )}
      {others}
    </div>
  );
}

const MAX_FIELDS = 12;

export function FieldList({ fields }: { fields: FieldChange[] }) {
  return (
    <ul
      className="mt-1 flex flex-col gap-1 text-xs"
      data-testid="history-diff-fields"
    >
      {fields.slice(0, MAX_FIELDS).map((f) => (
        <li key={f.path} className="min-w-0">
          <span className="font-mono text-muted-foreground">
            {fieldLabel(f.path) || "(block)"}
          </span>{" "}
          {f.words ? (
            <Words parts={f.words} />
          ) : f.formatting ? (
            <span className="text-muted-foreground">formatting changed</span>
          ) : (
            <ValueChange field={f} />
          )}
        </li>
      ))}
      {fields.length > MAX_FIELDS && (
        <li className="text-muted-foreground">
          +{fields.length - MAX_FIELDS} more
        </li>
      )}
    </ul>
  );
}

function Words({ parts }: { parts: WordPart[] }) {
  return (
    <span
      className="whitespace-pre-wrap break-words text-foreground"
      data-testid="history-words"
    >
      {parts.map((p, i) =>
        p.type === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.type === "add" ? (
          <ins
            key={i}
            className="rounded-sm bg-green-500/15 text-green-700 dark:text-green-700 dark:text-green-300 no-underline"
          >
            {p.text}
          </ins>
        ) : (
          <del
            key={i}
            className="rounded-sm bg-red-500/15 text-red-600 dark:text-red-600 dark:text-red-400"
          >
            {p.text}
          </del>
        )
      )}
    </span>
  );
}

function ValueChange({ field }: { field: FieldChange }) {
  if (field.kind === "added") {
    return (
      <span className="text-green-700 dark:text-green-300">
        added <Value v={field.after} />
      </span>
    );
  }
  if (field.kind === "removed") {
    return (
      <span className="text-red-600 dark:text-red-400">
        removed <Value v={field.before} />
      </span>
    );
  }
  if (field.before === "order") {
    return <span className="text-muted-foreground">reordered</span>;
  }
  return (
    <span className="text-muted-foreground">
      <del className="text-red-600 dark:text-red-400">
        <Value v={field.before} />
      </del>{" "}
      →{" "}
      <ins className="text-green-700 dark:text-green-300 no-underline">
        <Value v={field.after} />
      </ins>
    </span>
  );
}

/** A value in a field change; a colour shows as a swatch with its token name or hex. */
function Value({ v }: { v: unknown }) {
  if (!isColor(v)) {
    return <>{formatValue(v)}</>;
  }
  const name = "token" in v ? v.token : v.hex;
  return (
    <span
      className="inline-flex items-center gap-1 align-middle"
      data-testid="history-color"
    >
      <span
        className="inline-block h-3 w-3 rounded-sm border border-border"
        style={{
          background: "token" in v ? `var(--color-brand-${v.token})` : v.hex,
        }}
        aria-hidden="true"
      />
      {name}
    </span>
  );
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) {
    return "nothing";
  }
  const text =
    typeof v === "string" ? v : isRichText(v) ? richTextToPlain(v) : null;
  if (text !== null) {
    return `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  const json = JSON.stringify(v);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

// ---------------------------------------------------------------------------------------------
// Canvas and editor chrome

/** Inside the canvas while a version is viewed: diff outlines, and scrolling to a block picked in the panel. */
export function HistoryCanvasMarks() {
  const canvas = useCanvas();
  const diff = useHistoryDiff();
  const { focus } = useHistoryState();

  useEffect(() => {
    if (!(canvas && focus)) {
      return;
    }
    const el = canvas.document.querySelector(
      `[data-cms-key="${CSS.escape(focus.key)}"]`
    );
    // Scroll the frame only (scrollIntoView would also scroll the editor around it).
    if (el) {
      canvas.window.scrollBy({
        top: el.getBoundingClientRect().top - 16,
        behavior: "smooth",
      });
    }
  }, [canvas, focus]);

  if (!diff) {
    return null;
  }
  const css = diff.blocks
    .filter((b) => b.status !== "removed")
    .map(
      (b) =>
        `[data-cms-key="${CSS.escape(b.key)}"] { outline: 3px solid ${MARK[b.status].color} !important; outline-offset: -3px; }`
    )
    .join("\n");
  return (
    <style data-cms-ui="" data-testid="history-marks">
      {css}
    </style>
  );
}

/** Above the canvas while a version is viewed. */
export function HistoryViewingBar() {
  const view = useHistoryView();
  const { viewing, compare, busy } = useHistoryState();
  const { pageStatus } = useEditorState();
  const diff = useHistoryDiff();
  if (!viewing) {
    return null;
  }
  const { rev } = viewing;
  const legend = (["added", "changed", "moved"] as const).filter((s) =>
    diff?.blocks.some((b) => b.status === s)
  );
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-primary/40 bg-accent/10 px-4 py-2 text-sm text-foreground"
      role="status"
      data-testid="history-viewing-bar"
    >
      <span>
        Viewing the version from{" "}
        <strong>{new Date(rev.createdAt).toLocaleString()}</strong>
        {rev.label
          ? ` ("${rev.label}")`
          : ` (${KIND_TITLE[rev.kind].toLowerCase()})`}
        . Read-only.
      </span>
      {legend.length > 0 && (
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          {legend.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ outline: `2px solid ${MARK[s].color}` }}
              />
              {statusText(s, compare)}
            </span>
          ))}
        </span>
      )}
      <div className="ml-auto flex gap-2">
        <Button
          size="sm"
          onClick={() => view.openDialog({ kind: "restore", rev })}
          disabled={busy || pageStatus === "archived"}
          data-testid="viewing-restore"
        >
          Restore
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => view.backToDraft()}
          data-testid="viewing-back"
        >
          Back to draft
        </Button>
      </div>
    </div>
  );
}

/** "Save version…" for the top bar. */
export function SaveVersionButton() {
  const view = useHistoryView();
  const { pageStatus } = useEditorState();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-8 text-foreground hover:bg-muted hover:text-foreground"
      disabled={pageStatus === "archived"}
      title="Save version… (Ctrl/Cmd+Shift+S)"
      onClick={() => view.openDialog({ kind: "save" })}
      data-testid="save-version"
    >
      Save version…
    </Button>
  );
}

const DIALOG = "border-border bg-card text-foreground";

/** Save-version, rename and confirmation dialogs. Mount once inside HistoryViewContext. */
export function HistoryDialogs() {
  const view = useHistoryView();
  const { dialog, busy } = useHistoryState();
  const close = (open: boolean) => !(open || busy) && view.openDialog(null);
  return (
    <>
      <LabelDialog
        open={dialog?.kind === "save"}
        onOpenChange={close}
        title="Save version"
        description="Keeps the draft as it is now under a name, so you can find it in History."
        initial=""
        action="Save version"
        busy={busy}
        onSubmit={(label) => view.saveVersion(label)}
        testId="save-version-dialog"
      />
      <LabelDialog
        open={dialog?.kind === "rename"}
        onOpenChange={close}
        title="Rename version"
        description="Leave it empty to go back to the original name."
        initial={dialog?.kind === "rename" ? (dialog.rev.label ?? "") : ""}
        action="Rename"
        allowEmpty
        busy={busy}
        onSubmit={(label) =>
          dialog?.kind === "rename"
            ? view.rename(dialog.rev, label)
            : Promise.resolve(false)
        }
        testId="rename-dialog"
      />
      <AlertDialog
        open={dialog?.kind === "restore" || dialog?.kind === "rollback"}
        onOpenChange={close}
      >
        <AlertDialogContent className={DIALOG} data-testid="history-confirm">
          {dialog?.kind === "restore" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Restore {entryTitle(dialog.rev)}?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  The draft becomes this version. The current draft is kept in
                  History, so you can come back to it. The live page doesn't
                  change until you publish.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  className="border-border bg-transparent"
                  disabled={busy}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    void view.restore(dialog.rev);
                  }}
                  data-testid="confirm-restore"
                >
                  {busy ? "Restoring…" : "Restore"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {dialog?.kind === "rollback" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Roll the live page back?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  The public page goes back to the content published{" "}
                  {dateTime(dialog.rev.createdAt)}, straight away, at its
                  current address (the URL doesn't change). History gets a new
                  "Published" entry for it. Your draft, including unsaved edits
                  and undo, isn't changed: publishing the draft later replaces
                  the rolled-back page.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  className="border-border bg-transparent"
                  disabled={busy}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    void view.rollback(dialog.rev);
                  }}
                  data-testid="confirm-rollback"
                >
                  {busy ? "Rolling back…" : "Roll back live"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const MAX_LABEL = 80;

function LabelDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  action,
  allowEmpty = false,
  busy,
  onSubmit,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initial: string;
  action: string;
  allowEmpty?: boolean;
  busy: boolean;
  onSubmit: (label: string) => Promise<boolean>;
  testId: string;
}) {
  const [label, setLabel] = useState(initial);
  useEffect(() => {
    if (open) {
      setLabel(initial);
    }
  }, [open, initial]);
  const valid =
    (allowEmpty || label.trim().length > 0) && label.trim().length <= MAX_LABEL;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`sm:max-w-md ${DIALOG}`} data-testid={testId}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) {
              void onSubmit(label);
            }
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {description}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={label}
            maxLength={MAX_LABEL}
            placeholder="e.g. Before the pricing rewrite"
            onChange={(e) => setLabel(e.target.value)}
            className="border-border bg-background"
            data-testid={`${testId}-input`}
          />
          <DialogFooter>
            <Button
              type="submit"
              disabled={!valid || busy}
              data-testid={`${testId}-submit`}
            >
              {busy ? "Saving…" : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
