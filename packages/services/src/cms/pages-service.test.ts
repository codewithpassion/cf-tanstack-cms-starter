// biome-ignore-all lint/performance/noAwaitInLoops: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { beforeEach, describe, expect, it } from "bun:test";

import { block, doc, post, seo } from "@repo/cms-core/ops/test-docs";
import type { PageDoc, ValidationResult } from "@repo/cms-core/types";
import { createMemoryRepo } from "../testing/memory-repo";
import {
  applyDraftOps,
  archivePage,
  CmsError,
  checkSlugAvailable,
  createPage,
  getPage,
  labelRevision,
  listRevisions,
  publish,
  republish,
  restore,
  restoreBlock,
  rollbackLive,
  type ServiceDeps,
  saveVersion,
  unarchivePage,
  unpublish,
} from "./pages-service";
import type { RevisionRow } from "./repo";

const MIN = 60_000;

/** Rejects blocks of type "bad" and an empty SEO title; otherwise returns the doc unchanged. */
function validate(input: unknown): ValidationResult {
  const d = input as PageDoc;
  const errors = d.blocks.flatMap((b, i) =>
    b._type === "bad"
      ? [{ path: `blocks[${i}].props`, message: "bad block" }]
      : []
  );
  if (d.seo.title === "") {
    errors.push({ path: "seo.title", message: "required" });
  }
  return errors.length ? { ok: false, errors } : { ok: true, doc: d };
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    failing: false,
    async put(key: string, value: string) {
      if (this.failing) {
        throw new Error("KV unavailable");
      }
      store.set(key, value);
    },
    async delete(key: string) {
      if (this.failing) {
        throw new Error("KV unavailable");
      }
      store.delete(key);
    },
    async get(key: string) {
      if (this.failing) {
        throw new Error("KV unavailable");
      }
      return store.get(key) ?? null;
    },
    json(key: string) {
      const v = store.get(key);
      return v === undefined ? undefined : JSON.parse(v);
    },
  };
}

let t: number;
let ids: number;
let mem: ReturnType<typeof createMemoryRepo>;
let kv: ReturnType<typeof fakeKv>;
let d: ServiceDeps;

beforeEach(() => {
  t = Date.parse("2026-10-02T00:00:00Z");
  ids = 0;
  mem = createMemoryRepo();
  kv = fakeKv();
  d = {
    repo: mem.repo,
    kv,
    validate,
    labelFor: (type) => type.toUpperCase(),
    now: () => t,
    genId: () => `id${++ids}`,
  };
});

const newPage = (
  slug = "home",
  kind: "page" | "post" = "page",
  extra: Partial<PageDoc> = {}
) =>
  createPage(d, {
    kind,
    slug,
    title: `Title ${slug}`,
    doc: doc(undefined, { seo: seo({ title: `Title ${slug}` }), ...extra }),
  });

const setSlug = async (id: string, slug: string) =>
  applyDraftOps(d, id, await draftVersion(id), [
    { op: "setSeo", seo: { slug } },
  ]);
const ctaLabel = (r: { docJson: PageDoc }) =>
  (r.docJson.blocks[2]!.props as { label?: string }).label;

const draftVersion = async (id: string) =>
  (await getPage(d, { id }))!.draftVersion;

async function expectCmsError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(CmsError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("createPage / getPage", () => {
  it("creates a draft page and makes the slug authoritative", async () => {
    const page = await newPage("services/new");
    expect(page).toMatchObject({
      status: "draft",
      draftVersion: 0,
      liveRevId: null,
    });
    expect(page.draftDoc!.seo.slug).toBe("services/new");
    expect(await getPage(d, { slug: "services/new" })).toEqual(page);
  });

  it("rejects a taken slug and an invalid doc", async () => {
    await newPage("home");
    await expectCmsError(newPage("home"), "SLUG_TAKEN");
    const bad = createPage(d, {
      kind: "page",
      slug: "x",
      title: "X",
      doc: doc([block("b", "bad")]),
    });
    await expectCmsError(bad, "INVALID_DOC");
  });

  it("requires posts under blog/ with post metadata, and keeps pages out of blog/", async () => {
    await expectCmsError(newPage("blog/x", "post"), "BAD_KIND");
    await expectCmsError(
      newPage("news/x", "post", { post: post() }),
      "BAD_KIND"
    );
    await expectCmsError(newPage("blog/x", "page"), "BAD_KIND");
    // One segment after blog/: /blog/$slug can't serve deeper paths.
    await expectCmsError(
      newPage("blog/x/y", "post", { post: post() }),
      "BAD_KIND"
    );
    await expectCmsError(checkSlugAvailable(d, "post", "blog/x/y"), "BAD_KIND");
    expect(await newPage("blog/x", "post", { post: post() })).toMatchObject({
      kind: "post",
    });
  });

  // This site's code routes (reserved.ts); the home page and an event slug are CMS pages.
  it("rejects slugs owned by code routes, but allows the home page, an event slug and posts under blog/", async () => {
    for (const slug of [
      "login",
      "dev-login",
      "admin",
      "admin/pages",
      "blog",
      "api/x",
      "media/x",
    ]) {
      await expectCmsError(newPage(slug), "SLUG_RESERVED");
    }
    expect(await newPage("")).toMatchObject({ slug: "" });
    expect(await newPage("launch-event-2026-10-23")).toMatchObject({
      slug: "launch-event-2026-10-23",
    });
    expect(await newPage("blog/x", "post", { post: post() })).toMatchObject({
      kind: "post",
    });
  });

  it("rejects documents over 1,000,000 bytes serialised", async () => {
    const sized = (label: string) =>
      createPage(d, {
        kind: "page",
        slug: "big",
        title: "Big",
        doc: doc([block("cta", "cta", { label })]),
      });
    await expectCmsError(sized("é".repeat(500_000)), "DOC_TOO_LARGE"); // 1,000,000 bytes of label alone
    expect(await sized("x".repeat(900_000))).toMatchObject({ slug: "big" });
  });

  it("frees the slug when a page is archived", async () => {
    const page = await newPage("home");
    await archivePage(d, page.id);
    const again = await newPage("home");
    expect((await getPage(d, { slug: "home" }))!.id).toBe(again.id);
  });
});

describe("applyDraftOps", () => {
  it("saves, bumps the version and rejects stale versions", async () => {
    const page = await newPage();
    const r = await applyDraftOps(d, page.id, 0, [
      { op: "update", key: "cta", props: { label: "Go" } },
    ]);
    expect(r.draftVersion).toBe(1);
    expect(
      (await getPage(d, { id: page.id }))!.draftDoc!.blocks[2]!.props
    ).toEqual({ label: "Go" });
    await expectCmsError(
      applyDraftOps(d, page.id, 0, [{ op: "remove", key: "cta" }]),
      "STALE_DRAFT"
    );
  });

  it("acknowledges a retried batch (same id, response lost) instead of STALE_DRAFT", async () => {
    const page = await newPage();
    const ops = [{ op: "update" as const, key: "cta", props: { label: "Go" } }];
    expect(
      (await applyDraftOps(d, page.id, 0, ops, "batch-1")).draftVersion
    ).toBe(1);
    // The client never saw that response and resends the same batch.
    const retry = await applyDraftOps(d, page.id, 0, ops, "batch-1");
    expect(retry).toMatchObject({ draftVersion: 1, snapshotRevId: null });
    expect(retry.doc.blocks[2]!.props).toEqual({ label: "Go" });
    expect(await draftVersion(page.id)).toBe(1);
    // A different batch at the old version is a real conflict.
    await expectCmsError(
      applyDraftOps(d, page.id, 0, ops, "batch-2"),
      "STALE_DRAFT"
    );
    await expectCmsError(applyDraftOps(d, page.id, 0, ops), "STALE_DRAFT");
  });

  it("treats a replayed batch id as stale once anything else saved after it", async () => {
    const page = await newPage();
    const ops = [{ op: "update" as const, key: "cta", props: { label: "Go" } }];
    await applyDraftOps(d, page.id, 0, ops, "batch-1");
    await applyDraftOps(d, page.id, 1, [
      { op: "update", key: "cta", props: { label: "Other tab" } },
    ]);
    await expectCmsError(
      applyDraftOps(d, page.id, 0, ops, "batch-1"),
      "STALE_DRAFT"
    );
  });

  it("refuses edits to an archived page", async () => {
    const page = await newPage();
    await archivePage(d, page.id);
    await expectCmsError(
      applyDraftOps(d, page.id, 0, [
        { op: "update", key: "cta", props: { label: "Go" } },
      ]),
      "ARCHIVED"
    );
    expect(await draftVersion(page.id)).toBe(0);
  });

  it("rejects an invalid result without writing anything", async () => {
    const page = await newPage();
    const op = {
      op: "insert" as const,
      at: {},
      block: { _key: "b", _type: "bad", props: {} },
    };
    await expectCmsError(applyDraftOps(d, page.id, 0, [op]), "INVALID_DOC");
    expect(await draftVersion(page.id)).toBe(0);
    expect(mem.revisions).toHaveLength(0);
  });

  it("rejects malformed ops with INVALID_OPS and the op's path", async () => {
    const page = await newPage();
    const noKey = applyDraftOps(d, page.id, 0, [
      { op: "insert", at: {}, block: { _type: "cta", props: {} } },
    ]);
    await expectCmsError(noKey, "INVALID_OPS");
    await expect(noKey).rejects.toMatchObject({
      details: [{ path: "ops[0].block._key" }],
    });
    await expectCmsError(
      applyDraftOps(d, page.id, 0, [{ op: "rename", key: "cta" }]),
      "INVALID_OPS"
    );
    await expectCmsError(applyDraftOps(d, page.id, 0, "nope"), "INVALID_OPS");
    expect(await draftVersion(page.id)).toBe(0);
  });

  it("maps an op that can't apply to INVALID_OPS with its index", async () => {
    const page = await newPage();
    const missing = applyDraftOps(d, page.id, 0, [
      { op: "update", key: "cta", props: { label: "Go" } },
      { op: "remove", key: "nope" },
    ]);
    await expectCmsError(missing, "INVALID_OPS");
    await expect(missing).rejects.toMatchObject({ details: { opIndex: 1 } });
    expect(await draftVersion(page.id)).toBe(0);
  });

  it("rejects deeply nested op payloads without overflowing the stack", async () => {
    const page = await newPage();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) {
      deep = { x: deep };
    }
    const r = applyDraftOps(d, page.id, 0, [
      { op: "update", key: "cta", props: deep },
    ]);
    await expectCmsError(r, "INVALID_OPS");
    await expect(r).rejects.toMatchObject({
      details: [{ message: expect.stringContaining("nested") }],
    });
    let ok: Record<string, unknown> = { label: "Go" };
    for (let i = 0; i < 50; i++) {
      ok = { x: ok };
    }
    await expect(
      applyDraftOps(d, page.id, 0, [{ op: "update", key: "cta", props: ok }])
    ).resolves.toBeDefined();
  });

  it("autosnapshots the pre-edit draft: on the first edit, then once the latest revision is 5+ minutes old and differs", async () => {
    const page = await newPage();
    const edit = async (label: string) => {
      const v = await draftVersion(page.id);
      return (
        await applyDraftOps(d, page.id, v, [
          { op: "update", key: "cta", props: { label } },
        ])
      ).snapshotRevId;
    };
    const first = await edit("a");
    expect(first).not.toBeNull();
    expect(mem.revisions[0]).toMatchObject({
      kind: "autosnapshot",
      parentRevId: null,
    });
    expect(ctaLabel(mem.revisions[0]!)).toBe("Book"); // the doc as created, before the edit

    t += 4 * MIN + 59_000;
    expect(await edit("b")).toBeNull();
    t += 2000; // 5:01 after the snapshot
    const second = await edit("c");
    expect(second).not.toBeNull();
    // The end state of the previous session ("b"), not the edit that triggered the snapshot.
    expect(ctaLabel(mem.revisions[1]!)).toBe("b");
    expect(mem.revisions[1]).toMatchObject({
      parentRevId: first,
      summary: "Edited CTA label",
    });
    const after = (await getPage(d, { id: page.id }))!;
    expect(after.draftBaseRevId).toBe(second);
    expect((after.draftDoc!.blocks[2]!.props as { label: string }).label).toBe(
      "c"
    );

    // Nothing to capture when the draft before the edit matches the latest revision.
    const named = await saveVersion(d, page.id, "Checkpoint");
    t += 10 * MIN;
    expect(await edit("d")).toBeNull();
    expect(mem.revisions.at(-1)!.id).toBe(named.id);
  });

  it("writes no snapshot for a stale save", async () => {
    const page = await newPage();
    await expectCmsError(
      applyDraftOps(d, page.id, 7, [{ op: "remove", key: "cta" }]),
      "STALE_DRAFT"
    );
    expect(mem.revisions).toHaveLength(0);
  });

  it("writes the autosnapshot, the draft and the batch id in one commit: a failed commit leaves none of them", async () => {
    const page = await newPage();
    await applyDraftOps(d, page.id, 0, [
      { op: "update", key: "cta", props: { label: "Session 1 end" } },
    ]);
    t += 10 * MIN;
    const commit = mem.repo.commit;
    let commits = 0;
    mem.repo.commit = async () => {
      commits++;
      throw new Error("D1_ERROR: simulated");
    };
    const ops = [
      { op: "update" as const, key: "cta", props: { label: "Session 2" } },
    ];
    await expect(applyDraftOps(d, page.id, 1, ops, "batch-x")).rejects.toThrow(
      "D1_ERROR"
    );
    expect(commits).toBe(1);
    expect(mem.revisions).toHaveLength(1);
    expect(await getPage(d, { id: page.id })).toMatchObject({
      draftVersion: 1,
      lastBatchId: null,
    });
    expect(
      ctaLabel({ docJson: (await getPage(d, { id: page.id }))!.draftDoc! })
    ).toBe("Session 1 end");

    mem.repo.commit = async (...args) => {
      commits++;
      return commit(...args);
    };
    const retry = await applyDraftOps(d, page.id, 1, ops, "batch-x");
    expect(commits).toBe(2);
    expect(retry.snapshotRevId).toBe(mem.revisions[1]!.id);
    expect(ctaLabel(mem.revisions[1]!)).toBe("Session 1 end");
    expect(await getPage(d, { id: page.id })).toMatchObject({
      draftVersion: 2,
      lastBatchId: "batch-x",
      draftBaseRevId: retry.snapshotRevId,
    });
  });
});

describe("versions and restore", () => {
  it("saves named versions", async () => {
    const page = await newPage();
    const rev = await saveVersion(d, page.id, "Before redesign");
    expect(rev).toMatchObject({ kind: "named", label: "Before redesign" });
    expect((await listRevisions(d, page.id)).map((r) => r.id)).toEqual([
      rev.id,
    ]);
  });

  it("restore appends a revision, snapshots unsaved work first, and never removes history", async () => {
    const page = await newPage();
    const a = await saveVersion(d, page.id, "A");
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]); // within 5 min: no autosnapshot
    const before = structuredClone(mem.revisions);

    t += MIN;
    const r = await restore(d, page.id, a.id, await draftVersion(page.id));
    expect(r.doc).toEqual(a.docJson);
    expect(r.draftVersion).toBe(2);
    const after = await getPage(d, { id: page.id });
    expect(after!.draftDoc).toEqual(a.docJson);
    expect(after!.draftBaseRevId).toBe(r.revId);

    expect(mem.revisions.slice(0, before.length)).toEqual(before);
    const [snap, restored] = mem.revisions.slice(before.length) as [
      RevisionRow,
      RevisionRow,
    ];
    expect(snap).toMatchObject({ kind: "autosnapshot", parentRevId: a.id });
    expect(snap.docJson.blocks.map((b) => b._key)).toEqual(["hero", "cta"]);
    expect(restored).toMatchObject({
      kind: "restore",
      parentRevId: snap.id,
      summary: 'Restored "A" · Added FAQ (1 item)',
    });

    // An editor still holding the old version must reload.
    await expectCmsError(applyDraftOps(d, page.id, 1, []), "STALE_DRAFT");
  });

  it("restoreBlock replaces an existing block or re-inserts a removed one at its old index", async () => {
    const page = await newPage();
    const a = await saveVersion(d, page.id, "A");
    await applyDraftOps(d, page.id, 0, [
      { op: "update", key: "hero", props: { heading: "Changed" } },
      { op: "remove", key: "faq" },
    ]);

    await restoreBlock(d, page.id, a.id, "hero", 1);
    let draft = (await getPage(d, { id: page.id }))!.draftDoc!;
    expect(draft.blocks[0]).toEqual(a.docJson.blocks[0]);

    const r = await restoreBlock(d, page.id, a.id, "faq", 2);
    draft = (await getPage(d, { id: page.id }))!.draftDoc!;
    expect(draft.blocks.map((b) => b._key)).toEqual(["hero", "faq", "cta"]);
    expect(r.draftVersion).toBe(3);

    await expectCmsError(
      restoreBlock(d, page.id, a.id, "nope", 3),
      "NOT_FOUND"
    );
    await expectCmsError(
      restoreBlock(d, page.id, a.id, "hero", 1),
      "STALE_DRAFT"
    );
  });

  it("restoreBlock keeps unsnapshotted work in History and writes a restore revision, in one commit", async () => {
    const page = await newPage();
    await applyDraftOps(d, page.id, 0, [
      { op: "update", key: "hero", props: { heading: "V1" } },
    ]);
    const a = await saveVersion(d, page.id, "Before rewrite");
    await labelRevision(d, page.id, a.id, { label: "Renamed" });
    t += MIN;
    await applyDraftOps(d, page.id, 1, [
      { op: "update", key: "hero", props: { heading: "Careful copy" } },
    ]); // no autosnapshot (< 5 min)
    const before = mem.revisions.length;
    const commit = mem.repo.commit;
    let commits = 0;
    mem.repo.commit = async (...args) => {
      commits++;
      return commit(...args);
    };

    t += MIN;
    const r = await restoreBlock(d, page.id, a.id, "hero", 2);
    expect(commits).toBe(1);
    const [snap, restored, ...rest] = mem.revisions.slice(before) as [
      RevisionRow,
      RevisionRow,
      ...RevisionRow[],
    ];
    expect(rest).toEqual([]);
    expect(snap).toMatchObject({ kind: "autosnapshot", parentRevId: a.id });
    expect((snap.docJson.blocks[0]!.props as { heading: string }).heading).toBe(
      "Careful copy"
    );
    expect(restored).toMatchObject({
      kind: "restore",
      parentRevId: snap.id,
      summary: 'Restored block HERO from "Renamed"',
    });
    const after = (await getPage(d, { id: page.id }))!;
    expect(
      (after.draftDoc!.blocks[0]!.props as { heading: string }).heading
    ).toBe("V1");
    expect(after).toMatchObject({
      draftBaseRevId: restored.id,
      draftVersion: 3,
    });
    expect(r).toMatchObject({ revId: restored.id, draftVersion: 3 });

    // Nothing unsaved: no snapshot, just the restore revision.
    t += MIN;
    await restoreBlock(d, page.id, a.id, "faq", 3);
    expect(mem.revisions.slice(before + 2).map((x) => x.kind)).toEqual([
      "restore",
    ]);
  });

  it("restore names the revision by its current label", async () => {
    const page = await newPage();
    const a = await saveVersion(d, page.id, "A");
    await labelRevision(d, page.id, a.id, { label: "Launch copy" });
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    await restore(d, page.id, a.id, 1);
    expect(mem.revisions.at(-1)!.summary).toBe(
      'Restored "Launch copy" · Added FAQ (1 item)'
    );
  });

  it("restore drops blocks that fail today's validation, takes invalid SEO fields from the draft, and reports both", async () => {
    const page = await newPage();
    const old: RevisionRow = {
      id: "old",
      pageId: page.id,
      parentRevId: null,
      docJson: doc(
        [
          block("hero", "hero", { heading: "Old" }),
          block("gone", "bad"),
          block("cta", "cta", { label: "Old" }),
        ],
        {
          seo: seo({ title: "", slug: "home" }),
        }
      ),
      kind: "named",
      label: "Old",
      summary: "",
      author: null,
      agentRunId: null,
      createdAt: new Date(t),
    };
    await mem.repo.commit(page.id, [old]);
    t += MIN;
    const r = await restore(d, page.id, "old", 0);
    expect(r.dropped).toEqual([{ key: "gone", type: "bad" }]);
    expect(r.seoReplaced).toEqual(["title"]);
    expect(r.doc.blocks.map((b) => b._key)).toEqual(["hero", "cta"]);
    expect(r.doc.seo.title).toBe("Title home");
    expect((await getPage(d, { id: page.id }))!.draftDoc).toEqual(r.doc);
    expect(mem.revisions.at(-1)!.summary).toMatch(
      /^Restored "Old" \(dropped BAD; SEO title kept from the draft\) · /
    );

    // A migration hook runs before validation: a migrated block isn't dropped.
    d.migrateDoc = (raw) => {
      const x = structuredClone(raw) as PageDoc;
      for (const b of x.blocks) {
        if (b._type === "bad") {
          b._type = "faq";
        }
      }
      return x;
    };
    const again = await restore(d, page.id, "old", 1);
    expect(again.dropped).toEqual([]);
    expect(again.doc.blocks.map((b) => b._type)).toEqual([
      "hero",
      "faq",
      "cta",
    ]);
  });

  it("refuses to save a version, restore or restore a block on an archived page", async () => {
    const page = await newPage();
    const a = await saveVersion(d, page.id, "A");
    await archivePage(d, page.id);
    const n = mem.revisions.length;
    await expectCmsError(saveVersion(d, page.id, "B"), "ARCHIVED");
    await expectCmsError(restore(d, page.id, a.id, 0), "ARCHIVED");
    await expectCmsError(restoreBlock(d, page.id, a.id, "hero", 0), "ARCHIVED");
    expect(mem.revisions).toHaveLength(n);
  });

  it("publish and restore reject a stale draftVersion", async () => {
    const page = await newPage();
    const a = await saveVersion(d, page.id, "A");
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    const n = mem.revisions.length;
    await expectCmsError(publish(d, page.id, 0), "STALE_DRAFT");
    await expectCmsError(restore(d, page.id, a.id, 0), "STALE_DRAFT");
    expect(mem.revisions).toHaveLength(n);
    expect(await getPage(d, { id: page.id })).toMatchObject({
      status: "draft",
      draftVersion: 1,
    });
    expect(kv.store.size).toBe(0);
  });

  it("publish and restore commit with compare-and-set (a save between read and commit wins)", async () => {
    const page = await newPage();
    const a = await saveVersion(d, page.id, "A");
    const n = mem.revisions.length;
    const commit = mem.repo.commit;
    const sneakSave: typeof commit = async (...args) => {
      mem.repo.commit = commit;
      const v = await draftVersion(page.id);
      await mem.repo.saveDraft(page.id, v, doc(), new Date(t));
      return commit(...args);
    };
    mem.repo.commit = sneakSave;
    await expectCmsError(restore(d, page.id, a.id, 0), "STALE_DRAFT");
    mem.repo.commit = sneakSave;
    await expectCmsError(publish(d, page.id, 1), "STALE_DRAFT");
    expect(mem.revisions).toHaveLength(n);
    expect(await getPage(d, { id: page.id })).toMatchObject({
      status: "draft",
      draftVersion: 2,
      liveRevId: null,
    });
    expect(kv.store.size).toBe(0);
  });

  it("does not restore a revision of another page", async () => {
    const p1 = await newPage("one");
    const p2 = await newPage("two");
    const rev = await saveVersion(d, p1.id, "x");
    await expectCmsError(restore(d, p2.id, rev.id, 0), "NOT_FOUND");
  });
});

describe("publish", () => {
  it("writes a published revision, moves the live pointer and writes KV", async () => {
    const page = await newPage();
    const r = await publish(d, page.id, await draftVersion(page.id));
    expect(r).toEqual({ ok: true, live: true, revId: "id2" });
    expect(await getPage(d, { id: page.id })).toMatchObject({
      status: "published",
      liveRevId: r.revId,
      draftBaseRevId: r.revId,
    });
    expect(mem.revisions.at(-1)).toMatchObject({
      kind: "published",
      summary: "Added HERO · added FAQ (1 item) · added CTA",
    });
    expect(kv.json("page:home")).toEqual({
      revId: r.revId,
      publishedAt: new Date(t).toISOString(),
      kind: "page",
      doc: page.draftDoc,
    });
  });

  it("refuses with LIVE_CHANGED when the live revision moved since the caller looked", async () => {
    const page = await newPage();
    // Not live yet: the dialog saw null.
    const first = await publish(d, page.id, await draftVersion(page.id), {
      expectedLiveRevId: null,
    });
    await expectCmsError(
      publish(d, page.id, await draftVersion(page.id), {
        expectedLiveRevId: null,
      }),
      "LIVE_CHANGED"
    );
    const second = await publish(d, page.id, await draftVersion(page.id), {
      expectedLiveRevId: first.revId,
    });
    // Someone rolls back after the dialog loaded `second`.
    await rollbackLive(d, page.id, first.revId);
    await expectCmsError(
      publish(d, page.id, await draftVersion(page.id), {
        expectedLiveRevId: second.revId,
      }),
      "LIVE_CHANGED"
    );
    // Unpublished since: the live revision the dialog saw is gone.
    const live = (await getPage(d, { id: page.id }))!.liveRevId;
    await unpublish(d, page.id);
    await expectCmsError(
      publish(d, page.id, await draftVersion(page.id), {
        expectedLiveRevId: live,
      }),
      "LIVE_CHANGED"
    );
    // Without the option, publish doesn't check (e.g. the dialog couldn't load the live page).
    expect((await publish(d, page.id, await draftVersion(page.id))).ok).toBe(
      true
    );
  });

  it("reports live: false when KV fails, and republish fixes it", async () => {
    const page = await newPage();
    kv.failing = true;
    const r = await publish(d, page.id, await draftVersion(page.id));
    expect(r).toEqual({ ok: true, live: false, revId: r.revId });
    expect((await getPage(d, { id: page.id }))!.liveRevId).toBe(r.revId);
    expect(kv.store.size).toBe(0);

    kv.failing = false;
    expect(await republish(d, page.id)).toEqual({
      ok: true,
      live: true,
      revId: r.revId,
    });
    expect(kv.json("page:home").revId).toBe(r.revId);
  });

  it("republish also writes the slug redirect a failed publish missed", async () => {
    const page = await newPage("old");
    await publish(d, page.id, await draftVersion(page.id));
    await applyDraftOps(d, page.id, 0, [
      { op: "setSeo", seo: { slug: "new" } },
    ]);
    kv.failing = true;
    expect((await publish(d, page.id, await draftVersion(page.id))).live).toBe(
      false
    );
    kv.failing = false;
    expect((await republish(d, page.id)).live).toBe(true);
    expect(kv.store.get("redirect:old")).toBe("new");
    expect(kv.store.has("page:old")).toBe(false);
    expect(kv.json("page:new").doc.seo.slug).toBe("new");
  });

  it("cleans up a slug change whose KV write failed on the next successful publish", async () => {
    const page = await newPage("old");
    await publish(d, page.id, 0);
    await setSlug(page.id, "new");
    kv.failing = true;
    expect((await publish(d, page.id, 1)).live).toBe(false);
    kv.failing = false;
    await applyDraftOps(d, page.id, 1, [
      { op: "update", key: "cta", props: { label: "Go" } },
    ]);
    expect((await publish(d, page.id, 2)).live).toBe(true);
    expect(kv.store.get("redirect:old")).toBe("new");
    expect(kv.store.has("page:old")).toBe(false);
  });

  it("points every earlier slug straight at the current one (no chains, no loops)", async () => {
    const page = await newPage("a");
    await publish(d, page.id, 0);
    for (const slug of ["b", "c"]) {
      await setSlug(page.id, slug);
      await publish(d, page.id, await draftVersion(page.id));
    }
    expect(kv.store.get("redirect:a")).toBe("c");
    expect(kv.store.get("redirect:b")).toBe("c");
    expect([...kv.store.keys()].filter((k) => k.startsWith("page:"))).toEqual([
      "page:c",
    ]);

    await setSlug(page.id, "a"); // back to the first slug
    await publish(d, page.id, await draftVersion(page.id));
    expect(kv.store.has("redirect:a")).toBe(false);
    expect(kv.store.get("redirect:b")).toBe("a");
    expect(kv.store.get("redirect:c")).toBe("a");
    expect([...kv.store.keys()].filter((k) => k.startsWith("page:"))).toEqual([
      "page:a",
    ]);
  });

  it("a page taking a freed slug is not shadowed by its redirect, and the old page leaves it alone", async () => {
    const one = await newPage("a");
    await publish(d, one.id, 0);
    await setSlug(one.id, "b");
    await publish(d, one.id, 1);
    expect(kv.store.get("redirect:a")).toBe("b");

    const two = await newPage("a");
    const live = await publish(d, two.id, 0);
    expect(kv.store.has("redirect:a")).toBe(false);
    expect(kv.json("page:a").revId).toBe(live.revId);

    await republish(d, one.id);
    expect(kv.json("page:a").revId).toBe(live.revId);
    expect(kv.store.has("redirect:a")).toBe(false);
  });

  it("refuses to republish an unpublished page", async () => {
    const page = await newPage();
    await expectCmsError(republish(d, page.id), "NOT_PUBLISHED");
  });

  it("redirects the old slug when the slug changes", async () => {
    const page = await newPage("old");
    await publish(d, page.id, await draftVersion(page.id));
    await applyDraftOps(d, page.id, 0, [
      { op: "setSeo", seo: { slug: "new" } },
    ]);
    await publish(d, page.id, await draftVersion(page.id));
    expect((await getPage(d, { id: page.id }))!.slug).toBe("new");
    expect(kv.store.get("redirect:old")).toBe("new");
    expect(kv.store.has("page:old")).toBe(false);
    expect(kv.json("page:new").doc.seo.slug).toBe("new");
  });

  it("rejects publishing at a reserved slug", async () => {
    const page = await newPage("one");
    await setSlug(page.id, "login");
    await expectCmsError(publish(d, page.id, 1), "SLUG_RESERVED");
    expect(await getPage(d, { id: page.id })).toMatchObject({
      status: "draft",
      liveRevId: null,
    });
    expect(kv.store.size).toBe(0);
  });

  it("keeps pages:index to live pages and posts, rebuilt on publish and take-down", async () => {
    const a = await newPage("guides/a", "page", {
      seo: seo({
        title: "Guide A",
        description: "About A.",
        llms: { include: true, summary: "Sum A" },
      }),
    });
    const b = await newPage("b");
    const p = await newPage("blog/x", "post", { post: post() });
    await publish(d, a.id, 0);
    t += MIN;
    await publish(d, p.id, 0);
    expect(kv.json("pages:index")).toEqual([
      {
        slug: "blog/x",
        kind: "post",
        title: "Title blog/x",
        description: seo().description,
        updatedAt: new Date(t).toISOString(),
        lastmod: post().publishedAt,
        index: true,
        sitemapInclude: true,
        llmsInclude: seo().llms.include,
      },
      {
        slug: "guides/a",
        kind: "page",
        title: "Guide A",
        description: "About A.",
        updatedAt: new Date(t - MIN).toISOString(),
        index: true,
        sitemapInclude: true,
        llmsInclude: true,
        llmsSummary: "Sum A",
      },
    ]);
    await publish(d, b.id, 0);
    expect(kv.json("pages:index").map((e: { slug: string }) => e.slug)).toEqual(
      ["b", "blog/x", "guides/a"]
    );
    await unpublish(d, a.id);
    await archivePage(d, p.id);
    expect(kv.json("pages:index").map((e: { slug: string }) => e.slug)).toEqual(
      ["b"]
    );
  });

  it("rejects a slug another page owns", async () => {
    const page = await newPage("one");
    await newPage("two");
    await applyDraftOps(d, page.id, 0, [
      { op: "setSeo", seo: { slug: "two" } },
    ]);
    await expectCmsError(
      publish(d, page.id, await draftVersion(page.id)),
      "SLUG_TAKEN"
    );
    expect((await getPage(d, { id: page.id }))!.status).toBe("draft");
  });

  it("rejects an invalid draft", async () => {
    const page = await newPage();
    mem.pages[0]!.draftDoc = doc([block("b", "bad")]);
    await expectCmsError(
      publish(d, page.id, await draftVersion(page.id)),
      "INVALID_DOC"
    );
  });

  it("takes posts:index titles from the published doc, so a renamed post is renamed in the index", async () => {
    const p = await newPage("blog/x", "post", { post: post() });
    await publish(d, p.id, 0);
    await applyDraftOps(d, p.id, 0, [
      { op: "setSeo", seo: { title: "Renamed" } },
    ]);
    await publish(d, p.id, 1);
    expect(kv.json("posts:index")[0].title).toBe("Renamed");
  });

  it("refuses a slug change that moves a post out of blog/", async () => {
    const p = await newPage("blog/x", "post", { post: post() });
    await setSlug(p.id, "news/x");
    await expectCmsError(publish(d, p.id, 1), "BAD_KIND");
  });

  it("computes a post's reading time from its rich text on every save, whatever the client sent", async () => {
    const words = (n: number) =>
      Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const body = (n: number) => ({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: words(n) }] },
      ],
    });
    const p = await newPage("blog/x", "post", {
      post: post({ readingTime: 99 }),
      blocks: [block("b", "richText", { body: body(450) })],
    });
    expect(p.draftDoc?.post?.readingTime).toBe(3); // 450 words at 200 wpm
    const saved = await applyDraftOps(d, p.id, 0, [
      { op: "update", key: "b", props: { body: body(1000) } },
      { op: "setPost", post: { readingTime: 1 } },
    ]);
    expect(saved.doc.post?.readingTime).toBe(5);
    await publish(d, p.id, 1);
    expect(kv.json("posts:index")[0].readingTime).toBe(5);
    expect(kv.json("page:blog/x").doc.post.readingTime).toBe(5);
  });

  it("keeps posts:index to published posts, newest first", async () => {
    const older = await newPage("blog/older", "post", {
      post: post({ publishedAt: "2026-08-01", tags: ["a"] }),
    });
    const newer = await newPage("blog/newer", "post", {
      post: post({
        publishedAt: "2026-09-15",
        featuredImage: { mediaId: "m1", alt: "Alt" },
      }),
    });
    await newPage("blog/draft", "post", {
      post: post({ publishedAt: "2026-12-01" }),
    });
    await publish(d, older.id, await draftVersion(older.id));
    await publish(d, newer.id, await draftVersion(newer.id));

    expect(kv.json("posts:index")).toEqual([
      {
        slug: "blog/newer",
        title: "Title blog/newer",
        excerpt: "An excerpt",
        publishedAt: "2026-09-15",
        author: "Jane",
        readingTime: 0,
        category: "AI",
        tags: ["ai"],
        featuredImage: { mediaId: "m1", alt: "Alt" },
      },
      {
        slug: "blog/older",
        title: "Title blog/older",
        excerpt: "An excerpt",
        publishedAt: "2026-08-01",
        author: "Jane",
        readingTime: 0,
        category: "AI",
        tags: ["a"],
      },
    ]);

    await unpublish(d, newer.id);
    expect(kv.json("posts:index").map((p: { slug: string }) => p.slug)).toEqual(
      ["blog/older"]
    );
    expect(kv.store.has("page:blog/newer")).toBe(false);
  });

  it("unpublish again clears the page store after a failed KV take-down", async () => {
    const p = await newPage("blog/retry", "post", { post: post() });
    await publish(d, p.id, await draftVersion(p.id));
    expect(kv.store.has("page:blog/retry")).toBe(true);

    kv.failing = true;
    expect(await unpublish(d, p.id)).toEqual({ ok: true, synced: false });
    expect((await getPage(d, { id: p.id }))!.liveRevId).toBeNull();
    expect(kv.store.has("page:blog/retry")).toBe(true);

    kv.failing = false;
    expect(await unpublish(d, p.id)).toEqual({ ok: true, synced: true });
    expect(kv.store.has("page:blog/retry")).toBe(false);
    expect(kv.json("pages:index")).toEqual([]);
    expect(kv.json("posts:index")).toEqual([]);
  });

  it("lists posts by post.title (else the SEO title), the excerpt or else the description, and the reading time shown", async () => {
    const titled = await newPage("blog/titled", "post", {
      post: post({ title: "Post title", excerpt: "", readingTimeOverride: 9 }),
    });
    await publish(d, titled.id, 0);
    const [entry] = kv.json("posts:index");
    expect(entry).toMatchObject({
      title: "Post title",
      excerpt: seo().description,
      readingTime: 9,
    });
    expect(kv.json("pages:index")[0]).toMatchObject({
      title: "Post title",
      lastmod: "2026-09-01",
    });
  });

  it("dates a post's sitemap entry by its updated date when it has one", async () => {
    const p = await newPage("blog/x", "post", {
      post: post({ modifiedAt: "2026-09-20" }),
    });
    await publish(d, p.id, 0);
    expect(kv.json("pages:index")[0].lastmod).toBe("2026-09-20");
  });

  it("orders posts published the same day by slug", async () => {
    for (const slug of ["blog/b", "blog/c", "blog/a"]) {
      const p = await newPage(slug, "post", {
        post: post({ publishedAt: "2026-09-01" }),
      });
      await publish(d, p.id, 0);
    }
    expect(kv.json("posts:index").map((p: { slug: string }) => p.slug)).toEqual(
      ["blog/a", "blog/b", "blog/c"]
    );
  });
});

describe("rollbackLive / unpublish / archive", () => {
  it("publishes an old revision as a new published revision and leaves the draft alone", async () => {
    const page = await newPage();
    const first = await publish(d, page.id, await draftVersion(page.id));
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    await publish(d, page.id, await draftVersion(page.id));
    const draftBefore = (await getPage(d, { id: page.id }))!;

    t += MIN;
    const r = await rollbackLive(d, page.id, first.revId);
    const after = (await getPage(d, { id: page.id }))!;
    expect(after.liveRevId).toBe(r.revId);
    expect(after.draftDoc).toEqual(draftBefore.draftDoc);
    expect(after.draftBaseRevId).toBe(draftBefore.draftBaseRevId);
    expect(mem.revisions.at(-1)).toMatchObject({
      kind: "published",
      parentRevId: draftBefore.liveRevId,
      summary: "Rolled back live · Added FAQ (1 item)",
    });
    expect(kv.json("page:home").doc.blocks).toHaveLength(3);
  });

  it("keeps the page's current slug when rolling back to a revision published under an older one", async () => {
    const page = await newPage("old-url");
    const first = await publish(d, page.id, 0);
    await setSlug(page.id, "new-url");
    await publish(d, page.id, await draftVersion(page.id));

    const r = await rollbackLive(d, page.id, first.revId);
    expect(await getPage(d, { id: page.id })).toMatchObject({
      slug: "new-url",
      liveRevId: r.revId,
      status: "published",
    });
    expect(mem.revisions.at(-1)!.docJson.seo.slug).toBe("new-url");
    expect(kv.json("page:new-url").revId).toBe(r.revId);
    expect(kv.store.get("redirect:old-url")).toBe("new-url");
    expect(kv.store.has("page:old-url")).toBe(false);
  });

  it("refuses to roll back a page that isn't published", async () => {
    const page = await newPage();
    const live = await publish(d, page.id, 0);
    await unpublish(d, page.id);
    const n = mem.revisions.length;
    await expectCmsError(rollbackLive(d, page.id, live.revId), "NOT_PUBLISHED");
    expect(mem.revisions).toHaveLength(n);
    expect(await getPage(d, { id: page.id })).toMatchObject({
      status: "draft",
      liveRevId: null,
    });
    expect(kv.store.has("page:home")).toBe(false);
  });

  it("unpublish removes the KV doc and returns the page to draft", async () => {
    const page = await newPage();
    await publish(d, page.id, await draftVersion(page.id));
    expect(await unpublish(d, page.id)).toEqual({ ok: true, synced: true });
    expect(await getPage(d, { id: page.id })).toMatchObject({
      status: "draft",
      liveRevId: null,
    });
    expect(kv.store.has("page:home")).toBe(false);
    expect(mem.revisions).toHaveLength(1);
  });

  it("archive takes a live page down", async () => {
    const page = await newPage();
    await publish(d, page.id, await draftVersion(page.id));
    await archivePage(d, page.id);
    expect((await getPage(d, { id: page.id }))!.status).toBe("archived");
    expect(kv.store.has("page:home")).toBe(false);
  });

  it("refuses to unpublish, archive, publish or roll back an archived page", async () => {
    const a = await newPage("home");
    const live = await publish(d, a.id, 0);
    await archivePage(d, a.id);
    await newPage("home"); // takes the freed slug
    await expectCmsError(unpublish(d, a.id), "ARCHIVED");
    await expectCmsError(archivePage(d, a.id), "ARCHIVED");
    await expectCmsError(publish(d, a.id, 0), "ARCHIVED");
    await expectCmsError(rollbackLive(d, a.id, live.revId), "ARCHIVED");
    expect((await getPage(d, { id: a.id }))!.status).toBe("archived");
  });

  it("unarchive brings an archived page back as a draft at its slug, with its draft and history", async () => {
    const page = await newPage("about-us");
    await publish(d, page.id, 0);
    await applyDraftOps(d, page.id, 0, [{ op: "remove", key: "faq" }]);
    await archivePage(d, page.id);
    const revs = mem.revisions.length;
    t += MIN;
    const back = await unarchivePage(d, page.id);
    expect(back).toMatchObject({
      id: page.id,
      status: "draft",
      slug: "about-us",
    });
    expect(await getPage(d, { slug: "about-us" })).toMatchObject({
      id: page.id,
      status: "draft",
      liveRevId: null,
      draftVersion: 1,
      updatedAt: new Date(t),
    });
    expect(mem.revisions).toHaveLength(revs);
    expect(kv.store.has("page:about-us")).toBe(false);
    await expectCmsError(unarchivePage(d, page.id), "NOT_ARCHIVED");
  });

  it("refuses to unarchive when another page has taken the slug", async () => {
    const a = await newPage("about-us");
    await archivePage(d, a.id);
    const b = await newPage("about-us");
    await expectCmsError(unarchivePage(d, a.id), "SLUG_TAKEN");
    expect((await getPage(d, { id: a.id }))!.status).toBe("archived");
    await archivePage(d, b.id);
    expect((await unarchivePage(d, a.id)).status).toBe("draft");
  });

  it("take-down deletes the page's slug redirects, but not one another page now owns", async () => {
    const one = await newPage("a");
    await publish(d, one.id, 0);
    await setSlug(one.id, "b");
    await publish(d, one.id, 1);
    await setSlug(one.id, "c");
    await publish(d, one.id, 2);
    expect(kv.store.get("redirect:a")).toBe("c");
    expect(kv.store.get("redirect:b")).toBe("c");

    // Another page now owns the redirect from "b" (as if it had once been published there too).
    const two = await newPage("b2");
    await publish(d, two.id, 0);
    await kv.put("redirect:b", "b2");
    await unpublish(d, one.id);
    expect(kv.store.has("redirect:a")).toBe(false);
    expect(kv.store.get("redirect:b")).toBe("b2");
    expect(kv.store.has("page:c")).toBe(false);
  });

  it("reports synced: false when KV fails on unpublish", async () => {
    const page = await newPage();
    await publish(d, page.id, await draftVersion(page.id));
    kv.failing = true;
    expect(await unpublish(d, page.id)).toEqual({ ok: true, synced: false });
  });
});
