// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: intentional no-op callbacks, as in the source.
// biome-ignore-all lint/suspicious/noReturnAssign: test clock helper, as in the source.
// biome-ignore-all lint/suspicious/useAwait: async to satisfy promise-returning interfaces and callbacks; kept as in the source.
import { describe, expect, it } from "bun:test";

import type {
  AdminResult,
  PublishPageResult,
} from "@repo/cms-core/admin-result";
import { createBlock, getBlockDef } from "@repo/cms-core/blocks/registry";
import {
  dragValue,
  effectiveResponsive,
  paddingDragOp,
  resetResponsivePatch,
  setColorPatch,
  setResponsivePatch,
  styleOp,
  validateStylePatch,
} from "@repo/cms-core/editor/style-model";
import { mergeStyle, resolveResponsive } from "@repo/cms-core/style/vars";
import { sampleDoc } from "@repo/cms-core/test-fixtures";
import type { Block, Op, PageDoc } from "@repo/cms-core/types";
import { parseBlock } from "@repo/cms-core/validate";
import {
  type EditorDeps,
  EditorStore,
  type FieldError,
  type SaveFn,
} from "./store";

/** Fake clock + timers: `advance(ms)` runs due callbacks in order. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

type Call = { draftVersion: number; ops: Op[]; batchId: string };

type Fail = "stale" | "invalid" | "network" | "lostResponse" | "signedOut";

/** A fake server: records saves, applies version CAS, and resolves when the test says so. */
function fakeServer(startVersion = 0) {
  let version = startVersion;
  const calls: Call[] = [];
  const waiting: (() => void)[] = [];
  let manual = false;
  let failNext: Fail | null = null;
  let lastBatchId: string | null = null;
  const save: SaveFn = (draftVersion, ops, batchId) => {
    calls.push({ draftVersion, ops: structuredClone(ops), batchId });
    const respond = (): AdminResult<{ draftVersion: number }> => {
      const fail = failNext;
      failNext = null;
      if (fail === "network") {
        throw new Error("Failed to fetch");
      }
      if (fail === "signedOut") {
        return { ok: false, code: "SIGNED_OUT", message: "Sign in required." };
      }
      if (fail === "invalid") {
        return {
          ok: false,
          code: "INVALID_DOC",
          message: "blocks[0].props.heading: Too small",
        };
      }
      // Same idempotency rule as applyDraftOps: a replay of the last applied batch is acknowledged.
      if (
        draftVersion !== version &&
        batchId === lastBatchId &&
        version === draftVersion + 1
      ) {
        return { ok: true, draftVersion: version };
      }
      if (fail === "stale" || draftVersion !== version) {
        return { ok: false, code: "STALE_DRAFT", message: "reload" };
      }
      version += 1;
      lastBatchId = batchId;
      // Applied on the server, but the response never arrives.
      if (fail === "lostResponse") {
        throw new TypeError("Failed to fetch");
      }
      return { ok: true, draftVersion: version };
    };
    if (!manual) {
      return Promise.resolve().then(respond);
    }
    return new Promise((resolve, reject) =>
      waiting.push(() => {
        try {
          resolve(respond());
        } catch (err) {
          reject(err);
        }
      })
    );
  };
  const published: number[] = [];
  const publish = async (
    draftVersion: number
  ): Promise<AdminResult<PublishPageResult>> => {
    published.push(draftVersion);
    if (draftVersion !== version) {
      return { ok: false, code: "STALE_DRAFT", message: "reload" };
    }
    return { ok: true, live: true, revId: "rev1", path: "/services/sample" };
  };
  return {
    save,
    publish,
    calls,
    published,
    get version() {
      return version;
    },
    bumpElsewhere() {
      version += 1;
    },
    manual() {
      manual = true;
    },
    /** Answers the oldest waiting save. */
    release() {
      waiting.shift()?.();
    },
    get waiting() {
      return waiting.length;
    },
    failNext(kind: Fail) {
      failNext = kind;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function validateBlock(block: unknown): FieldError[] {
  return parseBlock(block).errors;
}

function setup({
  doc,
  ...opts
}: Partial<EditorDeps> & {
  pageStatus?: "draft" | "archived";
  doc?: PageDoc;
} = {}) {
  const timers = fakeTimers();
  const server = fakeServer();
  let ids = 0;
  const store = new EditorStore(
    {
      doc: doc ?? sampleDoc(),
      draftVersion: 0,
      pageStatus: opts.pageStatus ?? "draft",
      hasUnpublishedChanges: false,
    },
    {
      save: server.save,
      publish: server.publish,
      validateBlock,
      now: timers.now,
      schedule: timers.schedule,
      genId: () => `b${++ids}`,
      ...opts,
    }
  );
  return { store, timers, server };
}

const heading = (text: string): Op => ({
  op: "update",
  key: "hero1",
  props: { heading: text },
});
const headingOf = (doc: PageDoc) =>
  (doc.blocks[0]!.props as { heading: string }).heading;

describe("EditorStore: applying ops", () => {
  it("applies an op optimistically and marks the draft unsaved", () => {
    const { store } = setup();
    const res = store.apply([heading("Hi")]);
    expect(res.ok).toBe(true);
    const snap = store.getSnapshot();
    expect(headingOf(snap.doc)).toBe("Hi");
    expect(snap.status).toBe("unsaved");
    expect(snap.canUndo).toBe(true);
    expect(snap.hasUnpublishedChanges).toBe(true);
  });

  it("refuses an edit that makes the block invalid, changing nothing", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    const res = store.apply([heading("")]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]!.path).toBe("props.heading");
    }
    expect(store.getSnapshot()).toBe(before);
  });

  it("refuses an edit past the page-wide limits (blocks, SEO) up front, so nothing gets stuck", async () => {
    const { store, server } = setup();
    const many = Array.from({ length: 196 }, () => ({
      op: "insert" as const,
      at: {},
      block: createBlock("cta"),
    }));
    expect(store.apply(many).ok).toBe(true); // 200 blocks
    const res = store.apply([
      { op: "insert", at: {}, block: createBlock("cta") },
    ]);
    expect(res).toEqual({
      ok: false,
      errors: [
        { path: "blocks", message: "A page can have at most 200 blocks" },
      ],
    });
    const seo = store.apply([{ op: "setSeo", seo: { title: "" } }]);
    expect(seo.ok).toBe(false);
    if (!seo.ok) {
      expect(seo.errors[0]!.path).toBe("seo.title");
    }
    await store.save();
    expect(store.getSnapshot().status).toBe("saved");
    expect(server.calls).toHaveLength(1);
  });

  it("an archived page is read-only", () => {
    const { store } = setup({ pageStatus: "archived" });
    const res = store.apply([heading("A")]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]!.message).toMatch(/archived/);
    }
    expect(store.undo()).toBe(false);
  });

  it("refuses an op that can't apply", () => {
    const { store } = setup();
    const res = store.apply([{ op: "remove", key: "nope" }]);
    expect(res).toEqual({
      ok: false,
      errors: [{ path: "ops[0]", message: 'op 0: no block with key "nope"' }],
    });
  });

  it("selects an inserted block and drops a removed selection", () => {
    const { store } = setup();
    const res = store.apply([
      { op: "insert", at: { after: "hero1" }, block: createBlock("cta") },
    ]);
    expect(res.ok).toBe(true);
    const key = store.getSnapshot().doc.blocks[1]!._key;
    expect(store.getSnapshot().selectedKey).toBe(key);
    store.apply([{ op: "remove", key }]);
    expect(store.getSnapshot().selectedKey).toBeNull();
  });

  it("select() is idempotent (no notification for the same key)", () => {
    const { store } = setup();
    let n = 0;
    store.subscribe(() => n++);
    store.select("hero1");
    store.select("hero1");
    expect(n).toBe(1);
  });
});

describe("EditorStore: liveChanged (rollback)", () => {
  it("marks the page published and keeps the draft, undo history and pending edits", () => {
    const { store } = setup();
    store.apply([heading("Typing")]);
    store.liveChanged(false);
    const snap = store.getSnapshot();
    expect(snap).toMatchObject({
      pageStatus: "published",
      hasUnpublishedChanges: true,
      status: "unsaved",
      canUndo: true,
    });
    expect(headingOf(snap.doc)).toBe("Typing");
  });

  it("takes the server's answer when nothing is pending", () => {
    const { store } = setup();
    store.liveChanged(false);
    expect(store.getSnapshot().hasUnpublishedChanges).toBe(false);
    store.liveChanged(true);
    expect(store.getSnapshot().hasUnpublishedChanges).toBe(true);
  });
});

describe("EditorStore: undo/redo", () => {
  it("undoes a burst of typing in one field as one step, and queues the inverse for saving", async () => {
    const { store, timers, server } = setup();
    for (const text of ["H", "He", "Hel", "Hell", "Hello"]) {
      timers.advance(200);
      store.apply([heading(text)]);
    }
    expect(store.undo()).toBe(true);
    expect(headingOf(store.getSnapshot().doc)).toBe("Hello CMS");
    expect(store.getSnapshot().canUndo).toBe(false);
    timers.advance(1500);
    await flush();
    // One save. The five edits and the step's inverse ops all set the same field, so the queue
    // collapses them into the final value.
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.ops).toEqual([heading("Hello CMS")]);
    expect(store.redo()).toBe(true);
    expect(headingOf(store.getSnapshot().doc)).toBe("Hello");
  });

  it("starts a new step after a pause", () => {
    const { store, timers } = setup();
    store.apply([heading("A")]);
    timers.advance(1001);
    store.apply([heading("B")]);
    store.undo();
    expect(headingOf(store.getSnapshot().doc)).toBe("A");
  });

  it("redoes an insert with the same key, and the queued ops always carry keys", async () => {
    const { store, timers, server } = setup();
    store.apply([{ op: "insert", at: {}, block: createBlock("faq") }]);
    const key = store.getSnapshot().doc.blocks.at(-1)!._key;
    store.undo();
    store.redo();
    expect(store.getSnapshot().doc.blocks.at(-1)!._key).toBe(key);
    timers.advance(1500);
    await flush();
    const ops = server.calls[0]!.ops;
    expect(ops.map((op) => op.op)).toEqual(["insert", "remove", "insert"]);
    for (const op of ops) {
      if (op.op === "insert") {
        expect(op.block._key).toBe(key);
      }
    }
  });

  it("commits in-progress edits (flushers) before undoing", () => {
    const { store } = setup();
    const off = store.registerFlusher(() => store.apply([heading("Typed")]));
    store.undo();
    off();
    // The flusher's edit landed and was then undone: back to the original.
    expect(headingOf(store.getSnapshot().doc)).toBe("Hello CMS");
    expect(store.getSnapshot().canRedo).toBe(true);
  });
});

describe("EditorStore: saving", () => {
  it("autosaves 1.5s after the last edit, in one request", async () => {
    const { store, timers, server } = setup();
    store.apply([heading("A")]);
    timers.advance(1000);
    store.apply([{ op: "update", key: "grid1", props: { heading: "B" } }]);
    timers.advance(1499);
    expect(server.calls).toHaveLength(0);
    timers.advance(1);
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ draftVersion: 0 });
    expect(server.calls[0]!.ops).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 1,
    });
  });

  it("never overlaps saves: edits made while saving go in the next request, with the new version", async () => {
    const { store, timers, server } = setup();
    server.manual();
    store.apply([heading("A")]);
    const first = store.save();
    await flush();
    expect(store.getSnapshot().status).toBe("saving");
    store.apply([heading("B")]);
    const second = store.save();
    await flush();
    expect(server.calls).toHaveLength(1); // the second waits for the first
    server.release();
    await first;
    await flush();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toMatchObject({ draftVersion: 1 });
    server.release();
    await second;
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 2,
    });
    expect(timers.pending).toBeLessThanOrEqual(1);
  });

  it("save() with nothing pending sends nothing", async () => {
    const { store, server } = setup();
    await store.save();
    expect(server.calls).toHaveLength(0);
  });

  it("STALE_DRAFT: conflict, no more saves, edits refused until reset", async () => {
    const { store, timers, server } = setup();
    server.bumpElsewhere();
    store.apply([heading("A")]);
    await store.save();
    expect(store.getSnapshot().status).toBe("conflict");
    const res = store.apply([heading("B")]);
    expect(res.ok).toBe(false);
    timers.advance(10_000);
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(store.undo()).toBe(false);

    store.reset({
      doc: sampleDoc(),
      draftVersion: server.version,
      pageStatus: "draft",
      hasUnpublishedChanges: false,
    });
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 1,
      canUndo: false,
    });
    expect(store.apply([heading("C")]).ok).toBe(true);
    await store.save();
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 2,
    });
  });

  it("a rejected save (invalid doc) stops saving and asks for a reload", async () => {
    const { store, server } = setup();
    server.failNext("invalid");
    store.apply([heading("A")]);
    await store.save();
    expect(store.getSnapshot()).toMatchObject({
      status: "rejected",
      error: "blocks[0].props.heading: Too small",
    });
    expect(store.dirty).toBe(true);
  });

  it("a network failure resends the same batch (same id, version and ops) first, then newer edits", async () => {
    const { store, timers, server } = setup();
    server.failNext("network");
    store.apply([heading("A")]);
    await store.save();
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: "Failed to fetch",
    });
    store.apply([{ op: "update", key: "cta1", props: { heading: "AB" } }]);
    timers.advance(1500);
    await flush();
    await flush();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual(server.calls[0]);
    expect(store.getSnapshot()).toMatchObject({
      status: "unsaved",
      draftVersion: 1,
    });
    timers.advance(1500);
    await flush();
    expect(server.calls).toHaveLength(3);
    expect(server.calls[2]).toMatchObject({
      draftVersion: 1,
      ops: [{ key: "cta1" }],
    });
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 2,
    });
  });

  it("a lost response is retried with the same batch id and acknowledged, not a conflict", async () => {
    const { store, timers, server } = setup();
    server.failNext("lostResponse");
    store.apply([heading("A")]);
    await store.save();
    expect(store.getSnapshot().status).toBe("error");
    expect(server.version).toBe(1); // the server did apply it
    store.apply([{ op: "update", key: "cta1", props: { heading: "Later" } }]);
    timers.advance(1500);
    await flush();
    await flush();
    expect(server.calls[1]!.batchId).toBe(server.calls[0]!.batchId);
    expect(store.getSnapshot()).toMatchObject({
      status: "unsaved",
      draftVersion: 1,
    });
    await store.save();
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 2,
    });
    expect(server.calls.map((c) => c.batchId)).toEqual(["b1", "b1", "b2"]);
  });

  it("collapses consecutive updates of the same field, but not nested-object patches or other fields", async () => {
    const { store, timers, server } = setup();
    for (const text of ["A", "AB", "ABC"]) {
      store.apply([heading(text)]);
      timers.advance(1200); // separate undo steps, one save batch
    }
    store.apply([
      { op: "update", key: "hero1", props: { primary: { label: "Go" } } },
    ]);
    store.apply([
      { op: "update", key: "hero1", props: { primary: { href: "/go" } } },
    ]);
    store.apply([{ op: "update", key: "grid1", props: { heading: "G" } }]);
    await store.save();
    // Different props of one block merge too; two patches of the same nested object don't.
    expect(server.calls[0]!.ops).toEqual([
      {
        op: "update",
        key: "hero1",
        props: { heading: "ABC", primary: { label: "Go" } },
      },
      { op: "update", key: "hero1", props: { primary: { href: "/go" } } },
      { op: "update", key: "grid1", props: { heading: "G" } },
    ]);
    expect(headingOf(store.getSnapshot().doc)).toBe("ABC");
  });

  it("saves at most 10s after the oldest unsaved edit, even while typing continues", async () => {
    const { store, timers, server } = setup();
    for (let i = 0; i < 9; i++) {
      store.apply([heading(`T${i}`)]);
      timers.advance(1000);
    }
    store.apply([heading("T9")]); // t = 9s: the debounce alone would wait until 10.5s
    timers.advance(999);
    expect(server.calls).toHaveLength(0);
    timers.advance(1);
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.ops).toEqual([heading("T9")]);
  });

  it("signed out: keeps the edits, stops retrying, keeps accepting edits, and Retry resumes", async () => {
    const { store, timers, server } = setup();
    server.failNext("signedOut");
    store.apply([heading("A")]);
    await store.save();
    expect(store.getSnapshot()).toMatchObject({ status: "signed-out" });
    expect(store.dirty).toBe(true);
    expect(
      store.apply([{ op: "update", key: "cta1", props: { heading: "B" } }]).ok
    ).toBe(true);
    expect(store.getSnapshot().status).toBe("signed-out");
    timers.advance(60_000);
    await flush();
    expect(server.calls).toHaveLength(1);
    await store.retry();
    await store.save();
    expect(server.calls).toHaveLength(3);
    expect(server.calls[1]).toEqual(server.calls[0]);
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 2,
    });
    expect(headingOf(store.getSnapshot().doc)).toBe("A");
  });

  it("a signed-out publish switches to the signed-out state", async () => {
    const { store } = setup({
      publish: async () => ({
        ok: false,
        code: "SIGNED_OUT",
        message: "Sign in required.",
      }),
    });
    store.apply([heading("A")]);
    const res = await store.publish();
    expect(res).toMatchObject({ ok: false, code: "SIGNED_OUT" });
    expect(store.getSnapshot().status).toBe("signed-out");
  });
});

describe("EditorStore: publish", () => {
  it("dates a new post (publishedAtAuto) to the publish day with an ordinary edit, saved before the publish", async () => {
    const base = sampleDoc();
    const doc: PageDoc = {
      ...base,
      seo: { ...base.seo, slug: "blog/new" },
      post: {
        excerpt: "",
        author: "D",
        publishedAt: "2026-01-01",
        category: "AI",
        tags: [],
        readingTime: 0,
        publishedAtAuto: true,
      },
    };
    const { store, server, timers } = setup({ doc });
    timers.advance(Date.parse("2026-10-02T03:00:00Z")); // 03:00 UTC
    expect(await store.publish()).toMatchObject({ ok: true });
    expect(server.calls.map((c) => c.ops)).toEqual([
      [
        {
          op: "setPost",
          post: { publishedAt: "2026-10-02", publishedAtAuto: null },
        },
      ],
    ]);
    expect(server.published).toEqual([1]);
    expect(store.getSnapshot().doc.post).toMatchObject({
      publishedAt: "2026-10-02",
    });
    expect(store.getSnapshot().doc.post).not.toHaveProperty("publishedAtAuto");
    // Only the first publish: the flag is gone.
    await store.publish();
    expect(server.calls).toHaveLength(1);
  });

  it("leaves a post without the flag (migrated, or dated by hand) alone", async () => {
    const base = sampleDoc();
    const doc: PageDoc = {
      ...base,
      seo: { ...base.seo, slug: "blog/old" },
      post: {
        excerpt: "",
        author: "D",
        publishedAt: "2026-01-01",
        category: "AI",
        tags: [],
        readingTime: 0,
      },
    };
    const { store, server } = setup({ doc });
    await store.publish();
    expect(server.calls).toHaveLength(0);
    expect(store.getSnapshot().doc.post?.publishedAt).toBe("2026-01-01");
  });

  it("flushes pending edits first, then publishes the saved version", async () => {
    const { store, server } = setup();
    store.apply([heading("A")]);
    const res = await store.publish();
    expect(res).toMatchObject({ ok: true, path: "/services/sample" });
    expect(server.calls).toHaveLength(1);
    expect(server.published).toEqual([1]);
    expect(store.getSnapshot()).toMatchObject({
      pageStatus: "published",
      hasUnpublishedChanges: false,
      publishing: false,
    });
  });

  it("unpublished() makes the page a draft again and keeps unsaved edits", async () => {
    const { store } = setup();
    await store.publish();
    store.apply([heading("A")]);
    store.unpublished();
    expect(store.getSnapshot()).toMatchObject({
      pageStatus: "draft",
      hasUnpublishedChanges: false,
      status: "unsaved",
    });
    expect(headingOf(store.getSnapshot().doc)).toBe("A");
  });

  it("an autosave due during publish waits for it (no spurious conflict)", async () => {
    const { store, timers, server } = setup();
    server.manual();
    store.apply([heading("A")]);
    const publishing = store.publish();
    await flush();
    store.apply([heading("AB")]); // schedules an autosave
    timers.advance(1500); // fires: chained behind the publish
    server.release(); // the publish's flush
    const res = await publishing;
    expect(res).toMatchObject({ ok: true });
    expect(server.published).toEqual([1]);
    await flush();
    server.release(); // the autosave
    await store.save();
    expect(store.getSnapshot()).toMatchObject({
      status: "saved",
      draftVersion: 2,
      hasUnpublishedChanges: true,
    });
  });

  it("doesn't publish when the flush failed", async () => {
    const { store, server } = setup();
    server.bumpElsewhere();
    store.apply([heading("A")]);
    expect(await store.publish()).toBeNull();
    expect(server.published).toEqual([]);
    expect(store.getSnapshot().status).toBe("conflict");
  });
});

describe("EditorStore: history actions (whenSaved, lock)", () => {
  type Replaced = { editor: { doc: PageDoc; draftVersion: number } };
  const replace = (res: Replaced) => ({
    ...res.editor,
    pageStatus: "draft" as const,
    hasUnpublishedChanges: true,
  });

  it("saves pending edits before the call, then replaces the draft and clears undo history", async () => {
    const { store, server } = setup();
    store.apply([heading("Typed")]);
    expect(store.getSnapshot().canUndo).toBe(true);
    const restored = sampleDoc();
    (restored.blocks[0]!.props as { heading: string }).heading = "Restored";
    const seen: number[] = [];
    const res = await store.whenSaved(
      async (draftVersion): Promise<AdminResult<Replaced>> => {
        seen.push(draftVersion);
        // The edit reached the server before the restore was asked for.
        expect(server.calls).toHaveLength(1);
        return {
          ok: true,
          editor: { doc: restored, draftVersion: draftVersion + 1 },
        };
      },
      { replace }
    );
    expect(res?.ok).toBe(true);
    expect(seen).toEqual([1]);
    const snap = store.getSnapshot();
    expect(headingOf(snap.doc)).toBe("Restored");
    expect(snap).toMatchObject({
      draftVersion: 2,
      status: "saved",
      canUndo: false,
      canRedo: false,
      hasUnpublishedChanges: true,
    });
    expect(store.dirty).toBe(false);
  });

  it("does not call when the draft can't be saved first", async () => {
    const { store, server } = setup();
    store.apply([heading("Typed")]);
    server.failNext("stale");
    let called = false;
    const res = await store.whenSaved(async () => {
      called = true;
      return { ok: true };
    });
    expect(res).toBeNull();
    expect(called).toBe(false);
    expect(store.getSnapshot().status).toBe("conflict");
  });

  it("maps STALE_DRAFT to a conflict and keeps the draft", async () => {
    const { store } = setup();
    const before = store.getSnapshot().doc;
    const res = await store.whenSaved(
      async () =>
        ({ ok: false, code: "STALE_DRAFT", message: "reload" }) as const,
      {
        replace: () => {
          throw new Error("not on failure");
        },
      }
    );
    expect(res).toMatchObject({ ok: false, code: "STALE_DRAFT" });
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      doc: before,
    });
  });

  it("keeps the save chain going after a call throws", async () => {
    const { store, server } = setup();
    await expect(
      store.whenSaved(async () => Promise.reject(new Error("Failed to fetch")))
    ).rejects.toThrow("Failed to fetch");
    store.apply([heading("After")]);
    await store.save();
    expect(server.calls).toHaveLength(1);
    expect(store.getSnapshot().status).toBe("saved");
  });

  it("refuses edits, undo and redo while locked, but still saves what was queued", async () => {
    const { store, server } = setup();
    store.apply([heading("Queued")]);
    store.lock("You're viewing an older version.");
    expect(store.apply([heading("Blocked")])).toEqual({
      ok: false,
      errors: [{ path: "", message: "You're viewing an older version." }],
    });
    expect(store.undo()).toBe(false);
    await store.save();
    expect(server.calls).toHaveLength(1);
    expect(headingOf(store.getSnapshot().doc)).toBe("Queued");
    store.lock(null);
    expect(store.apply([heading("Free")]).ok).toBe(true);
  });
});

// Moved from cms-core's style-model.test (needs the web EditorStore).
const heroDefaults = getBlockDef("hero")!.defaultStyle; // padding desktop top 128 / bottom 80

describe("Style panel ops through the editor store", () => {
  const store = (doc: PageDoc) =>
    new EditorStore(
      {
        doc,
        draftVersion: 1,
        pageStatus: "draft",
        hasUnpublishedChanges: false,
      },
      {
        save: async (v) => ({ ok: true, draftVersion: v + 1 }),
        publish: async () => ({
          ok: false,
          code: "NOT_PUBLISHED",
          message: "n/a",
        }),
        validateBlock: (b) => parseBlock(b).errors,
        schedule: () => () => {},
        now: (() => {
          let t = 0;
          return () => (t += 5000); // far apart: no history coalescing between steps
        })(),
      }
    );
  const block = (s: EditorStore) => s.getSnapshot().doc.blocks[0]!;

  it("desktop 96 / mobile 48, then reset mobile → inherits desktop; each change is one undo step", () => {
    const s = store(docWith(createBlock("hero", { _key: "b1" })));
    const original = structuredClone(s.getSnapshot().doc);
    expect(
      s.apply([styleOp("b1", setResponsivePatch("padding.top", "desktop", 96))])
        .ok
    ).toBe(true);
    expect(
      s.apply([styleOp("b1", setResponsivePatch("padding.top", "mobile", 48))])
        .ok
    ).toBe(true);
    expect(block(s).style?.padding).toEqual({
      desktop: { top: 96, bottom: 80 },
      mobile: { top: 48 },
    });
    const merged = mergeStyle(heroDefaults, block(s).style).padding;
    const rendered = resolveResponsive<number>({
      desktop: merged?.desktop?.top,
      tablet: merged?.tablet?.top,
      mobile: merged?.mobile?.top,
    });
    expect([rendered.desktop, rendered.tablet, rendered.mobile]).toEqual([
      96, 96, 48,
    ]);

    expect(
      s.apply([
        styleOp(
          "b1",
          resetResponsivePatch(block(s).style, "padding.top", "mobile")!
        ),
      ]).ok
    ).toBe(true);
    expect(block(s).style?.padding).toEqual({
      desktop: { top: 96, bottom: 80 },
    });
    expect(
      effectiveResponsive(block(s).style, heroDefaults, "padding.top", "mobile")
    ).toEqual({
      value: 96,
      source: { kind: "inherited", from: "desktop" },
    });

    expect(s.undo() && s.undo() && s.undo()).toBe(true);
    expect(s.getSnapshot().doc).toEqual(original);
    expect(s.getSnapshot().canUndo).toBe(false);
  });

  it("switches a colour between a token and a hex (the other kind is removed, not merged in)", () => {
    const s = store(docWith(createBlock("hero", { _key: "b1" })));
    expect(
      s.apply([styleOp("b1", setColorPatch("colors.text", { token: "white" }))])
        .ok
    ).toBe(true);
    expect(
      validateStylePatch(
        block(s),
        setColorPatch("colors.text", { hex: "#123456" })
      )
    ).toBeNull();
    expect(
      s.apply([styleOp("b1", setColorPatch("colors.text", { hex: "#123456" }))])
        .ok
    ).toBe(true);
    expect(block(s).style?.colors?.text).toEqual({ hex: "#123456" });
    expect(
      s.apply([
        styleOp("b1", setColorPatch("colors.text", { token: "accent" })),
      ]).ok
    ).toBe(true);
    expect(block(s).style?.colors?.text).toEqual({ token: "accent" });
  });

  it("a canvas drag commits a single op: one history entry, one undo restores the block", () => {
    const s = store(docWith(createBlock("hero", { _key: "b1" })));
    const before = structuredClone(block(s));
    const op = paddingDragOp(
      block(s),
      heroDefaults,
      "mobile",
      "top",
      dragValue(128, -79)
    )!;
    expect(op).toEqual(styleOp("b1", { padding: { mobile: { top: 48 } } }));
    expect(s.apply([op]).ok).toBe(true);
    expect(s.undo()).toBe(true);
    expect(block(s)).toEqual(before);
    expect(s.getSnapshot().canUndo).toBe(false);
  });

  it("undoes style ops on a block that had no style, including a nested reset", () => {
    const bare: Block = {
      _key: "b1",
      _type: "hero",
      _v: 1,
      props: createBlock("hero").props,
    };
    const s = store(docWith(bare));
    expect(
      s.apply([styleOp("b1", setResponsivePatch("hide", "tablet", true))]).ok
    ).toBe(true);
    expect(
      s.apply([
        styleOp("b1", resetResponsivePatch(block(s).style, "hide", "tablet")!),
      ]).ok
    ).toBe(true);
    expect(block(s).style).toBeUndefined();
    s.undo();
    expect(block(s).style).toEqual({ hide: { tablet: true } });
    s.undo();
    expect(block(s)).toEqual(bare);
  });

  it("refuses invalid style ops with a message and leaves the doc alone", () => {
    const s = store(docWith(createBlock("hero", { _key: "b1" })));
    const before = s.getSnapshot().doc;
    const tooBig = s.apply([
      styleOp("b1", setResponsivePatch("padding.top", "desktop", 4000)),
    ]);
    expect(tooBig.ok).toBe(false);
    const unsupported = s.apply([
      styleOp(
        "b1",
        setResponsivePatch("elements.headingAccent.align", "desktop", "left")
      ),
    ]);
    expect(unsupported).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringMatching(/does not support "align"/) }],
    });
    expect(s.getSnapshot().doc).toBe(before);
  });
});

function docWith(block: Block): PageDoc {
  return { ...sampleDoc(), blocks: [block] };
}
