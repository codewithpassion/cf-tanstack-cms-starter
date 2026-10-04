// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/useReadonlyClassProperties: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.

import type {
  AdminResult,
  PageStatus,
  PublishPageResult,
} from "@repo/cms-core/admin-result";
import { applyOps, OpError } from "@repo/cms-core/ops/apply-ops";
import { createHistory, type History } from "@repo/cms-core/ops/history";
import { todayIn } from "@repo/cms-core/posts";
import type { Block, Op, PageDoc } from "@repo/cms-core/types";
import { pageLimitErrors } from "@repo/cms-core/validate";
import { nanoid } from "nanoid";

/**
 * The editor's single source of state: the draft document, the
 * selection, undo/redo history and the save queue. Every mutation is a typed `Op`: applied locally
 * first (optimistic), recorded in history, and queued for the server. Saves are debounced (but
 * never wait more than `maxWaitMs` after the oldest unsaved edit) and chained on one promise, so at
 * most one request is in flight and they land in order; publish rides the same chain.
 *
 * Each save request is a batch with an id. A batch whose outcome is unknown (network error, lost
 * response, signed out) is resent unchanged, alone, before anything newer, so the server can
 * recognise a replay of a batch it already applied (applyDraftOps `batchId`).
 * Framework-free; `useEditorStore` (use-editor-store.ts) binds it to React.
 */

export type SaveStatus =
  /** Everything is on the server. */
  | "saved"
  /** Local changes wait for the autosave. */
  | "unsaved"
  | "saving"
  /** The server's draft moved on (another tab or person): reload. Nothing saves until then. */
  | "conflict"
  /** The server refused a save it will keep refusing (invalid ops or doc): reload. */
  | "rejected"
  /** The session ended. Edits keep queueing; nothing saves until the user signs in again and retries. */
  | "signed-out"
  /** A save failed (network, 5xx); it is retried. */
  | "error";

export type EditorSnapshot = {
  doc: PageDoc;
  /** The server's draft version our next save builds on. */
  draftVersion: number;
  selectedKey: string | null;
  status: SaveStatus;
  /** Why the last save or publish failed, for the banner. */
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  publishing: boolean;
  pageStatus: PageStatus;
  /** The draft differs from the live page (best effort: undoing back to it still counts as a change). */
  hasUnpublishedChanges: boolean;
};

/** `keepalive`: the page is unloading; the request should outlive it. */
export type SaveOptions = { keepalive?: boolean };
/** `batchId` identifies this batch; a retry of the same batch sends the same id, version and ops. */
export type SaveFn = (
  draftVersion: number,
  ops: Op[],
  batchId: string,
  opts?: SaveOptions
) => Promise<AdminResult<{ draftVersion: number }>>;
/** `expectedLiveRevId`: the live revision the user compared against (null: not live); omitted, not checked. */
export type PublishFn = (
  draftVersion: number,
  opts?: { expectedLiveRevId?: string | null }
) => Promise<AdminResult<PublishPageResult>>;

export type FieldError = { path: string; message: string };
export type ApplyOutcome =
  | { ok: true; ops: Op[] }
  | { ok: false; errors: FieldError[] };

export type EditorInit = {
  doc: PageDoc;
  draftVersion: number;
  pageStatus: PageStatus;
  hasUnpublishedChanges: boolean;
};

/** Cancels a scheduled callback. */
type Cancel = () => void;

export type EditorDeps = {
  save: SaveFn;
  publish: PublishFn;
  /**
   * Errors for a block after an edit (the block registry's `parseBlock`). An edit that would make a
   * block invalid is refused locally: the server validates the whole document and would reject the
   * whole batch.
   */
  validateBlock?: (block: Block) => FieldError[];
  autosaveMs?: number;
  /** The longest an edit waits for its autosave while typing continues. */
  maxWaitMs?: number;
  retryMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Cancel;
  /** Batch ids. */
  genId?: () => string;
};

export const AUTOSAVE_MS = 1500;
export const MAX_WAIT_MS = 10_000;
export const RETRY_MS = 5000;

/** A save request: kept until the server answers, and resent unchanged if it doesn't. */
type Batch = { id: string; draftVersion: number; ops: Op[] };

const defaultSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export class EditorStore {
  private snapshot: EditorSnapshot;
  private history: History;
  private listeners = new Set<() => void>();
  /** Applied locally, not yet sent. */
  private pending: Op[] = [];
  /** When the oldest op in `pending` was applied. */
  private pendingSince: number | null = null;
  /** Sent, and not acknowledged yet (in flight, or failed without an answer). */
  private unconfirmed: Batch | null = null;
  private inflight = false;
  private chain: Promise<unknown> = Promise.resolve();
  private cancelTimer: Cancel | null = null;
  /** In-progress edits (inline text, rich text debounce) that must land before undo, save or publish. */
  private flushers = new Set<() => void>();
  /** Why edits are refused for now (e.g. an older version is on the canvas). Saving carries on. */
  private lockReason: string | null = null;
  private readonly deps: Required<Omit<EditorDeps, "validateBlock">> &
    Pick<EditorDeps, "validateBlock">;

  constructor(init: EditorInit, deps: EditorDeps) {
    this.deps = {
      autosaveMs: AUTOSAVE_MS,
      maxWaitMs: MAX_WAIT_MS,
      retryMs: RETRY_MS,
      now: Date.now,
      schedule: defaultSchedule,
      // nanoid, not crypto.randomUUID: randomUUID only exists in secure contexts, and a dev server
      // browsed over plain http has none. Batch ids only need to be unique.
      genId: () => nanoid(),
      ...deps,
    };
    this.history = createHistory({ now: this.deps.now });
    this.snapshot = this.initial(init);
  }

  // --- React binding -------------------------------------------------------------------------

  getSnapshot = (): EditorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<EditorSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
    };
    for (const l of this.listeners) {
      l();
    }
  }

  // --- Editing -------------------------------------------------------------------------------

  /** Registers an in-progress edit to commit before undo/redo/save/publish. Returns an unregister function. */
  registerFlusher(fn: () => void): () => void {
    this.flushers.add(fn);
    return () => this.flushers.delete(fn);
  }

  /** Commits in-progress edits (each flusher may call `apply`). */
  flushEdits() {
    for (const fn of [...this.flushers]) {
      fn();
    }
  }

  /**
   * Applies `ops` to the draft, records one undo step (coalesced per ops/history.ts) and queues
   * them for saving. Refused, with nothing changed, when an op can't apply, an edited block would
   * become invalid, the page would break a page-wide limit, or the draft can't be edited
   * (conflict, rejected, archived).
   */
  apply(ops: Op[]): ApplyOutcome {
    if (!ops.length) {
      return { ok: true, ops: [] };
    }
    const blocked = this.lockReason ?? this.blockedReason();
    if (blocked) {
      return { ok: false, errors: [{ path: "", message: blocked }] };
    }
    const result = this.tryApply(ops);
    if (!result.ok) {
      return result;
    }
    this.history.push(result.ops, result.inverse);
    this.commit(
      result.doc,
      result.ops,
      this.selectionAfter(result.doc, result.ops)
    );
    return { ok: true, ops: result.ops };
  }

  undo(): boolean {
    return this.step("undo");
  }

  redo(): boolean {
    return this.step("redo");
  }

  private step(dir: "undo" | "redo"): boolean {
    this.flushEdits();
    if (this.lockReason ?? this.blockedReason()) {
      return false;
    }
    const ops = dir === "undo" ? this.history.undo() : this.history.redo();
    if (!ops) {
      return false;
    }
    let result: ReturnType<typeof applyOps>;
    try {
      result = applyOps(this.snapshot.doc, ops);
    } catch (err) {
      // History out of step with the doc (shouldn't happen): drop the step rather than wedge.
      console.error("EditorStore: could not apply history step", err);
      this.set({});
      return false;
    }
    this.commit(
      result.doc,
      result.ops,
      this.selectionAfter(result.doc, result.ops)
    );
    return true;
  }

  /**
   * Refuses edits (apply, undo, redo) with `reason` until unlocked with null, e.g. while the
   * history panel shows an older version. Queued saves still go out.
   */
  lock(reason: string | null) {
    this.lockReason = reason;
  }

  select(key: string | null) {
    if (key === this.snapshot.selectedKey) {
      return;
    }
    this.set({ selectedKey: key });
  }

  private tryApply(
    ops: Op[]
  ):
    | { ok: true; doc: PageDoc; ops: Op[]; inverse: Op[] }
    | { ok: false; errors: FieldError[] } {
    let result: ReturnType<typeof applyOps>;
    try {
      result = applyOps(this.snapshot.doc, ops);
    } catch (err) {
      if (err instanceof OpError) {
        return {
          ok: false,
          errors: [{ path: `ops[${err.opIndex}]`, message: err.message }],
        };
      }
      throw err;
    }
    if (this.deps.validateBlock) {
      const errors: FieldError[] = [];
      for (const key of touchedKeys(result.ops)) {
        const block = result.doc.blocks.find((b) => b._key === key);
        if (block) {
          errors.push(...this.deps.validateBlock(block));
        }
      }
      if (errors.length) {
        return { ok: false, errors };
      }
    }
    // The server checks the whole document and would refuse the whole batch, stranding every
    // other queued edit: refuse here instead.
    const limits = pageLimitErrors(result.doc, {
      seo: result.ops.some((op) => op.op === "setSeo"),
      post: result.ops.some((op) => op.op === "setPost"),
    });
    if (limits.length) {
      return { ok: false, errors: limits };
    }
    return { ok: true, ...result };
  }

  private commit(doc: PageDoc, ops: Op[], selectedKey: string | null) {
    this.pending.push(...ops);
    this.pendingSince ??= this.deps.now();
    const signedOut = this.snapshot.status === "signed-out";
    this.set({
      doc,
      selectedKey,
      status: signedOut ? "signed-out" : this.inflight ? "saving" : "unsaved",
      hasUnpublishedChanges: true,
    });
    if (!signedOut) {
      this.scheduleSave(this.autosaveDelay());
    }
  }

  /** The debounce, cut short so the oldest unsaved edit waits at most `maxWaitMs`. */
  private autosaveDelay(): number {
    const waited =
      this.pendingSince === null ? 0 : this.deps.now() - this.pendingSince;
    return Math.max(
      0,
      Math.min(this.deps.autosaveMs, this.deps.maxWaitMs - waited)
    );
  }

  /** A removed selection moves to nothing; an inserted block becomes the selection. */
  private selectionAfter(doc: PageDoc, ops: Op[]): string | null {
    const inserted = [...ops].reverse().find((op) => op.op === "insert");
    if (inserted?.op === "insert" && inserted.block._key) {
      return inserted.block._key;
    }
    const key = this.snapshot.selectedKey;
    return key && doc.blocks.some((b) => b._key === key) ? key : null;
  }

  private blockedReason(): string | null {
    const { status, pageStatus } = this.snapshot;
    if (pageStatus === "archived") {
      return "This page is archived, so it can't be edited.";
    }
    if (status === "conflict") {
      return "The draft changed elsewhere. Reload it to keep editing.";
    }
    if (status === "rejected") {
      return "A change couldn't be saved. Reload the draft to keep editing.";
    }
    return null;
  }

  // --- Saving --------------------------------------------------------------------------------

  /** True while anything hasn't reached the server. */
  get dirty(): boolean {
    return this.pending.length > 0 || this.unconfirmed !== null;
  }

  private scheduleSave(ms: number) {
    this.cancelTimer?.();
    this.cancelTimer = this.deps.schedule(() => {
      this.cancelTimer = null;
      void this.save();
    }, ms);
  }

  /**
   * Saves now (Cmd/Ctrl+S). Resolves once everything queued so far has been attempted (one batch:
   * after a failed one, its resend). `keepalive` for the save on the way out of the page.
   */
  save(opts?: SaveOptions): Promise<void> {
    this.flushEdits();
    this.cancelTimer?.();
    this.cancelTimer = null;
    const run = this.chain.then(() => this.flushOnce(opts));
    this.chain = run;
    return run;
  }

  /** After "signed-out" (the user signed in again) or "error": try saving now. */
  retry(): Promise<void> {
    const { status } = this.snapshot;
    if (status === "signed-out" || status === "error") {
      this.set({ status: this.dirty ? "unsaved" : "saved", error: null });
    }
    return this.save();
  }

  /** One save request: the unconfirmed batch if there is one, else everything pending. Never rejects. */
  private async flushOnce(opts?: SaveOptions): Promise<void> {
    if (this.blockedReason() || this.snapshot.status === "signed-out") {
      return;
    }
    let batch = this.unconfirmed;
    if (!batch) {
      if (!this.pending.length) {
        return;
      }
      batch = {
        id: this.deps.genId(),
        draftVersion: this.snapshot.draftVersion,
        ops: compactOps(this.pending),
      };
      this.pending = [];
      this.pendingSince = null;
      this.unconfirmed = batch;
    }
    this.inflight = true;
    this.set({ status: "saving" });
    let res: Awaited<ReturnType<SaveFn>>;
    try {
      res = await this.deps.save(batch.draftVersion, batch.ops, batch.id, opts);
    } catch (err) {
      // No answer (network, 5xx): the server may or may not have applied it. Resend it as is later.
      this.inflight = false;
      this.set({ status: "error", error: message(err) });
      this.scheduleSave(this.deps.retryMs);
      return;
    }
    this.inflight = false;
    if (res.ok) {
      this.unconfirmed = null;
      this.set({
        draftVersion: res.draftVersion,
        status: this.pending.length ? "unsaved" : "saved",
        error: null,
      });
      if (this.pending.length && !this.cancelTimer) {
        this.scheduleSave(this.autosaveDelay());
      }
      return;
    }
    if (res.code === "SIGNED_OUT") {
      // Refused before anything was applied. Keep the batch for Retry; no timed retries.
      this.set({ status: "signed-out", error: res.message });
      return;
    }
    // The server didn't take them. Keep them queued (a reload discards them) and stop saving.
    this.unconfirmed = null;
    this.pending = [...batch.ops, ...this.pending];
    this.set({
      status: res.code === "STALE_DRAFT" ? "conflict" : "rejected",
      error: res.message,
    });
  }

  /**
   * Publishes the draft as saved: rides the save chain (flush first, so the server's draft version
   * is the one we hold, then publish), so no autosave can land between them and turn the publish
   * into a spurious STALE_DRAFT. Returns null if the draft couldn't be saved first.
   */
  publish(opts?: {
    expectedLiveRevId?: string | null;
  }): Promise<AdminResult<PublishPageResult> | null> {
    this.flushEdits();
    // A new post still carrying its creation day (`publishedAtAuto`) is dated today on its first
    // publish; the change is an ordinary edit, saved before the publish, so draft and live agree.
    if (this.snapshot.doc.post?.publishedAtAuto) {
      this.apply([
        {
          op: "setPost",
          post: {
            publishedAt: todayIn("UTC", this.deps.now()),
            publishedAtAuto: null,
          },
        },
      ]);
    }
    this.cancelTimer?.();
    this.cancelTimer = null;
    const run = this.chain.then(async () => {
      await this.flushOnce();
      // "unsaved": the flush landed and newer edits arrived meanwhile; publish what was saved.
      const { status } = this.snapshot;
      if (status !== "saved" && status !== "unsaved") {
        return null;
      }
      this.set({ publishing: true });
      let res: AdminResult<PublishPageResult>;
      try {
        res = await this.deps.publish(this.snapshot.draftVersion, opts);
      } catch (err) {
        this.set({ publishing: false, error: message(err) });
        return {
          ok: false as const,
          code: "NOT_PUBLISHED" as const,
          message: message(err),
        };
      }
      if (res.ok) {
        this.set({
          publishing: false,
          pageStatus: "published",
          hasUnpublishedChanges: this.dirty,
          error: null,
        });
      } else {
        this.set({
          publishing: false,
          error: res.message,
          ...(res.code === "STALE_DRAFT" && { status: "conflict" as const }),
          ...(res.code === "SIGNED_OUT" && { status: "signed-out" as const }),
        });
      }
      return res;
    });
    this.chain = run;
    return run;
  }

  /**
   * Runs a server call that needs the saved draft (history: save version, restore, roll back) on
   * the save chain, like publish: everything queued saves first and no autosave lands in between.
   * `call` gets the server's draft version. Resolves null, without calling, if the draft couldn't
   * be saved. A `STALE_DRAFT` or `SIGNED_OUT` answer sets the status as a failed save would. With
   * `replace`, a successful call's draft becomes the editor's (like "Reload draft": undo history
   * is cleared). A thrown error is rethrown, and the chain carries on.
   */
  whenSaved<T extends object>(
    call: (draftVersion: number) => Promise<AdminResult<T>>,
    opts: { replace?: (res: T) => EditorInit } = {}
  ): Promise<AdminResult<T> | null> {
    this.flushEdits();
    this.cancelTimer?.();
    this.cancelTimer = null;
    const run = this.chain.then(async () => {
      await this.flushOnce();
      // Edits that arrived while the first batch was in flight.
      if (this.pending.length) {
        await this.flushOnce();
      }
      if (this.snapshot.status !== "saved" || this.dirty) {
        return null;
      }
      let res: AdminResult<T>;
      try {
        res = await call(this.snapshot.draftVersion);
      } catch (err) {
        this.set({ error: message(err) });
        throw err;
      }
      if (res.ok) {
        if (opts.replace) {
          this.reset(opts.replace(res));
        }
      } else if (res.code === "STALE_DRAFT" || res.code === "SIGNED_OUT") {
        this.set({
          status: res.code === "STALE_DRAFT" ? "conflict" : "signed-out",
          error: res.message,
        });
      }
      return res;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * The live page changed without the draft (a rollback): it's published, and the draft differs
   * from it per the server (`savedDraftDiffers`) or by edits not saved yet. Draft, undo and
   * pending saves are untouched.
   */
  liveChanged(savedDraftDiffers: boolean) {
    this.set({
      pageStatus: "published",
      hasUnpublishedChanges: savedDraftDiffers || this.dirty,
    });
  }

  /** The page was taken off the site: it's a draft again. Draft, undo and pending saves are untouched. */
  unpublished() {
    this.set({ pageStatus: "draft", hasUnpublishedChanges: false });
  }

  /** Replaces everything with a freshly loaded draft ("Reload draft"). Drops unsaved changes and history. */
  reset(init: EditorInit) {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.pending = [];
    this.pendingSince = null;
    this.unconfirmed = null;
    this.history = createHistory({ now: this.deps.now });
    const selected = this.snapshot.selectedKey;
    this.snapshot = this.initial(init);
    this.set({
      selectedKey:
        selected && init.doc.blocks.some((b) => b._key === selected)
          ? selected
          : null,
    });
  }

  /** Stops timers; starts a best-effort save of anything pending. */
  dispose(): Promise<void> {
    const saving = this.dirty ? this.save() : Promise.resolve();
    this.cancelTimer?.();
    this.cancelTimer = null;
    return saving;
  }

  private initial(init: EditorInit): EditorSnapshot {
    return {
      doc: init.doc,
      draftVersion: init.draftVersion,
      selectedKey: null,
      status: "saved",
      error: null,
      canUndo: false,
      canRedo: false,
      publishing: false,
      pageStatus: init.pageStatus,
      hasUnpublishedChanges: init.hasUnpublishedChanges,
    };
  }
}

/**
 * Collapses consecutive `update`s of one block into one when the later op overwrites each prop the
 * earlier one set (a string, number, array or null: merge-patch replaces those wholesale). Nested
 * object patches (links, rich text) and style patches are left alone: they merge, not replace.
 * Applying the result gives the same document as applying `ops`.
 */
export function compactOps(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const prev = out.at(-1);
    if (
      prev?.op === "update" &&
      op.op === "update" &&
      prev.key === op.key &&
      !prev.style &&
      !op.style &&
      prev.props &&
      op.props &&
      Object.keys(prev.props).every(
        (k) => !(Object.hasOwn(op.props!, k) && isPlainObject(op.props![k]))
      )
    ) {
      out[out.length - 1] = {
        op: "update",
        key: op.key,
        props: { ...prev.props, ...op.props },
      };
    } else {
      out.push(op);
    }
  }
  return out;
}

const isPlainObject = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Blocks whose content an op sets (moves and removes can't make a block invalid). */
function touchedKeys(ops: Op[]): Set<string> {
  const keys = new Set<string>();
  for (const op of ops) {
    if (op.op === "update" || op.op === "replace") {
      keys.add(op.key);
    } else if (op.op === "insert" && op.block._key) {
      keys.add(op.block._key);
    }
  }
  return keys;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
