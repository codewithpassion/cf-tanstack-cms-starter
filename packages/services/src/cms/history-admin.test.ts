// biome-ignore-all lint/complexity/noVoid: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/noAwaitInLoops: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { beforeEach, describe, expect, it } from "bun:test";

import { doc, seo } from "@repo/cms-core/ops/test-docs";
import type { PageDoc, ValidationResult } from "@repo/cms-core/types";
import { createMemoryRepo } from "../testing/memory-repo";
import { editorPageFromWire } from "./admin-result";
import {
  HISTORY_PAGE_SIZE,
  labelRevision,
  listHistory,
  restoreBlockFromRevision,
  restoreRevision,
  revisionDoc,
  rollbackLive,
  saveNamedVersion,
} from "./history-admin";
import {
  applyDraftOps,
  createPage,
  getPage,
  publish,
  type ServiceDeps,
} from "./pages-service";

const validate = (input: unknown): ValidationResult => ({
  ok: true,
  doc: input as PageDoc,
});

let t: number;
let ids: number;
let mem: ReturnType<typeof createMemoryRepo>;
let d: ServiceDeps;

beforeEach(() => {
  t = Date.parse("2026-10-02T00:00:00Z");
  ids = 0;
  mem = createMemoryRepo();
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  d = {
    repo: mem.repo,
    kv,
    validate,
    labelFor: (type) => type,
    now: () => t,
    genId: () => `id${++ids}`,
    author: "user_me",
  };
});

const newPage = (slug = "home") =>
  createPage(d, {
    kind: "page",
    slug,
    title: slug,
    doc: doc(undefined, { seo: seo({ slug }) }),
  });
const version = async (id: string) => (await getPage(d, { id }))!.draftVersion;
const keys = (docJson: string) =>
  (JSON.parse(docJson) as PageDoc).blocks.map((b) => b._key);

function ok<T extends object>(
  res: { ok: boolean } & object
): asserts res is { ok: true } & T {
  if (!res.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  }
}

describe("history server functions: error mapping", () => {
  it("maps a stale restore to STALE_DRAFT and writes nothing", async () => {
    const page = await newPage();
    const a = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(a);
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    const n = mem.revisions.length;
    expect(
      await restoreRevision(d, {
        pageId: page.id,
        revId: a.revId,
        draftVersion: 0,
      })
    ).toMatchObject({
      ok: false,
      code: "STALE_DRAFT",
    });
    expect(
      await restoreBlockFromRevision(d, {
        pageId: page.id,
        revId: a.revId,
        blockKey: "faq",
        draftVersion: 0,
      })
    ).toMatchObject({
      ok: false,
      code: "STALE_DRAFT",
    });
    expect(
      await saveNamedVersion(d, {
        pageId: page.id,
        label: "B",
        draftVersion: 0,
      })
    ).toMatchObject({ ok: false, code: "STALE_DRAFT" });
    expect(mem.revisions).toHaveLength(n);
  });

  it("does not hand out or act on another page's revision (NOT_FOUND)", async () => {
    const one = await newPage("one");
    const two = await newPage("two");
    const rev = await saveNamedVersion(d, { pageId: one.id, label: "x" });
    ok<{ revId: string }>(rev);
    const notFound = { ok: false, code: "NOT_FOUND" };
    expect(
      await revisionDoc(d, { pageId: two.id, revId: rev.revId })
    ).toMatchObject(notFound);
    expect(
      await restoreRevision(d, {
        pageId: two.id,
        revId: rev.revId,
        draftVersion: 0,
      })
    ).toMatchObject(notFound);
    expect(
      await rollbackLive(d, { pageId: two.id, revId: rev.revId })
    ).toMatchObject(notFound);
    expect(
      await labelRevision(d, { pageId: two.id, revId: rev.revId, pinned: true })
    ).toMatchObject(notFound);
    expect(await listHistory(d, { pageId: "nope" })).toMatchObject(notFound);
  });

  it("refuses to roll the live page back to a version that was never published (NOT_PUBLISHED)", async () => {
    const page = await newPage();
    const named = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(named);
    expect(
      await rollbackLive(d, { pageId: page.id, revId: named.revId })
    ).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });
  });

  it("rejects bad input before touching the page", async () => {
    const page = await newPage();
    expect(() =>
      saveNamedVersion(d, { pageId: page.id, label: "   " })
    ).toThrow(/version name/);
    expect(() =>
      saveNamedVersion(d, { pageId: page.id, label: "x".repeat(81) })
    ).toThrow(/version name/);
    await expect(
      listHistory(d, { pageId: page.id, cursor: "-1" })
    ).rejects.toThrow(/cursor/);
  });
});

describe("history server functions", () => {
  it("lists newest first with live, author and display labels, and pages with a cursor", async () => {
    const page = await newPage();
    const a = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(a);
    t += 1000;
    const pub = await publish(d, page.id, await version(page.id));
    const res = await listHistory(d, { pageId: page.id });
    ok<{ revisions: { id: string }[] }>(res);
    expect(res.revisions).toEqual([
      expect.objectContaining({
        id: pub.revId,
        kind: "published",
        isLive: true,
        byYou: true,
        author: "user_me",
        pinned: false,
      }),
      expect.objectContaining({
        id: a.revId,
        kind: "named",
        label: "A",
        isLive: false,
        createdAt: "2026-10-02T00:00:00.000Z",
      }),
    ]);
    expect(res.nextCursor).toBeNull();

    // Another admin's view: same rows, not "You".
    const other = await listHistory(
      { ...d, author: "user_other" },
      { pageId: page.id }
    );
    ok<{ revisions: { byYou: boolean }[] }>(other);
    expect(other.revisions.map((r) => r.byYou)).toEqual([false, false]);
  });

  it("pages through long histories without gaps", async () => {
    const page = await newPage();
    for (let i = 0; i < HISTORY_PAGE_SIZE + 3; i++) {
      await saveNamedVersion(d, { pageId: page.id, label: `v${i}` });
    }
    const first = await listHistory(d, { pageId: page.id });
    ok<{ revisions: { label: string }[]; nextCursor: string }>(first);
    expect(first.revisions).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.revisions[0]!.label).toBe(`v${HISTORY_PAGE_SIZE + 2}`);
    const second = await listHistory(d, {
      pageId: page.id,
      cursor: first.nextCursor!,
    });
    ok<{ revisions: { label: string }[] }>(second);
    expect(second.revisions.map((r) => r.label)).toEqual(["v2", "v1", "v0"]);
    expect(second.nextCursor).toBeNull();
    expect(second.pinned).toEqual([]);
  });

  it("renames and pins without touching the revision row", async () => {
    const page = await newPage();
    const a = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(a);
    const before = structuredClone(mem.revisions);
    expect(
      await labelRevision(d, {
        pageId: page.id,
        revId: a.revId,
        label: "  Launch copy ",
        pinned: true,
      })
    ).toEqual({ ok: true });
    let res = await listHistory(d, { pageId: page.id });
    ok<{
      revisions: { label: string; pinned: boolean }[];
      pinned: { id: string }[];
    }>(res);
    expect(res.revisions[0]).toMatchObject({
      label: "Launch copy",
      pinned: true,
    });
    expect(res.pinned.map((r) => r.id)).toEqual([a.revId]);

    // Unpin keeps the name; an empty name drops the rename and shows the original label again.
    await labelRevision(d, { pageId: page.id, revId: a.revId, pinned: false });
    await labelRevision(d, { pageId: page.id, revId: a.revId, label: "" });
    res = await listHistory(d, { pageId: page.id });
    ok<{ revisions: { label: string; pinned: boolean }[]; pinned: unknown[] }>(
      res
    );
    expect(res.revisions[0]).toMatchObject({ label: "A", pinned: false });
    expect(res.pinned).toEqual([]);
    expect(mem.revisions).toEqual(before);
  });

  it("restore returns the reloaded editor page; nothing is removed", async () => {
    const page = await newPage();
    const a = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(a);
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    const before = structuredClone(mem.revisions);
    const res = await restoreRevision(d, {
      pageId: page.id,
      revId: a.revId,
      draftVersion: 1,
    });
    ok<{ revId: string; editor: Parameters<typeof editorPageFromWire>[0] }>(
      res
    );
    const editor = editorPageFromWire(res.editor);
    expect(editor.draftVersion).toBe(2);
    expect(editor.draftDoc).toEqual(
      mem.revisions.find((r) => r.id === a.revId)!.docJson
    );
    expect(mem.revisions.slice(0, before.length)).toEqual(before);
    expect(
      mem.revisions.slice(before.length).map((r) => [r.kind, r.author])
    ).toEqual([
      ["autosnapshot", "user_me"],
      ["restore", "user_me"],
    ]);
    expect(res).toMatchObject({ dropped: [], seoReplaced: [] });
  });

  it("restoreBlockFromRevision writes a restore revision (History shows it)", async () => {
    const page = await newPage();
    const a = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(a);
    await applyDraftOps(d, page.id, 0, [
      { op: "update", key: "hero", props: { heading: "Changed" } },
    ]);
    const res = await restoreBlockFromRevision(d, {
      pageId: page.id,
      revId: a.revId,
      blockKey: "hero",
      draftVersion: 1,
    });
    ok(res);
    const list = await listHistory(d, { pageId: page.id });
    ok<{ revisions: { kind: string; summary: string | null }[] }>(list);
    expect(list.revisions[0]).toMatchObject({
      kind: "restore",
      summary: 'Restored block hero from "A"',
    });
  });

  it("restores one block only", async () => {
    const page = await newPage();
    const a = await saveNamedVersion(d, { pageId: page.id, label: "A" });
    ok<{ revId: string }>(a);
    await applyDraftOps(d, page.id, 0, [
      { op: "update", key: "hero", props: { heading: "Changed" } },
      { op: "remove", key: "faq" },
    ]);
    const res = await restoreBlockFromRevision(d, {
      pageId: page.id,
      revId: a.revId,
      blockKey: "faq",
      draftVersion: 1,
    });
    ok<{ editor: Parameters<typeof editorPageFromWire>[0] }>(res);
    expect(keys(res.editor.draftDocJson)).toEqual(["hero", "faq", "cta"]);
    // The hero edit is still there.
    expect(
      (
        editorPageFromWire(res.editor).draftDoc.blocks[0]!.props as {
          heading: string;
        }
      ).heading
    ).toBe("Changed");
    expect(res.editor.draftVersion).toBe(2);
  });

  it("rolls the live page back and reports its path; the draft is untouched", async () => {
    const page = await newPage("services-x");
    const first = await publish(d, page.id, 0);
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    await publish(d, page.id, 1);
    const res = await rollbackLive(d, { pageId: page.id, revId: first.revId });
    ok<{
      live: boolean;
      path: string;
      editor: Parameters<typeof editorPageFromWire>[0];
    }>(res);
    expect(res).toMatchObject({ live: true, path: "/services-x" });
    expect(keys(res.editor.draftDocJson)).toEqual(["hero", "cta"]);
    expect(res.editor.hasUnpublishedChanges).toBe(true);
    expect(res.editor.draftVersion).toBe(1);
  });
});
