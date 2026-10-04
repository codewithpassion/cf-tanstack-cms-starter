// biome-ignore-all lint/performance/noNamespaceImport: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noReturnAssign: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it, mock, spyOn } from "bun:test";

import { defaultSiteDoc } from "@repo/cms-core/site/defaults";
import type { LiveSite, SiteDoc } from "@repo/cms-core/site/types";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";

import { createSiteMemoryRepo } from "../testing/site-memory-repo";
import type { KvPort } from "./kv";
import { AUTOSNAPSHOT_AFTER_MS, CmsError } from "./pages-service";
import {
  readSite,
  readSiteSeo,
  SITE_CACHE_TTL_S,
  SITE_KV_KEY,
} from "./read-site";
import * as site from "./site-service";

const DEFAULT_SITE = defaultSiteDoc(TEST_CONFIG);

function memoryKv(opts: { failPuts?: boolean } = {}) {
  const store = new Map<string, string>();
  const kv: KvPort & { failPuts: boolean } = {
    failPuts: opts.failPuts ?? false,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      if (kv.failPuts) {
        throw new Error("KV down");
      }
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
  return { kv, store };
}

function setup(opts: { failPuts?: boolean } = {}) {
  const mem = createSiteMemoryRepo();
  const { kv, store } = memoryKv(opts);
  let t = Date.parse("2026-10-02T00:00:00Z");
  let n = 0;
  const d: site.SiteDeps = {
    repo: mem.repo,
    kv,
    config: TEST_CONFIG,
    now: () => t,
    genId: () => `r${++n}`,
    author: "user_1",
  };
  return { d, mem, kv, store, advance: (ms: number) => (t += ms) };
}

const withCmsTest = (doc: SiteDoc): SiteDoc => {
  const next = structuredClone(doc);
  next.nav.links.push({
    _key: "cms-test",
    label: "CMS Test",
    href: "/cms-test",
  });
  return next;
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CmsError) {
      return err.code;
    }
    throw err;
  }
  return "no error";
}

describe("site service", () => {
  it("starts from the defaults with no row and no history", async () => {
    const { d } = setup();
    expect(await site.getSiteState(d)).toEqual({
      doc: DEFAULT_SITE,
      draftVersion: 0,
      liveRevId: null,
      liveDoc: DEFAULT_SITE,
      changes: [],
    });
    expect(
      (await site.siteHistory(d, { limit: 10, offset: 0 })).revisions
    ).toEqual([]);
  });

  it("first save keeps the defaults as the first revision; later saves are compare-and-set", async () => {
    const { d, mem } = setup();
    const edited = withCmsTest(DEFAULT_SITE);
    expect(await site.saveSiteDraft(d, 0, edited)).toEqual({
      draftVersion: 1,
      doc: edited,
    });
    expect(mem.revisions).toHaveLength(1);
    expect(mem.revisions[0]).toMatchObject({
      kind: "autosnapshot",
      docJson: DEFAULT_SITE,
      author: "user_1",
    });
    expect(mem.row?.draftBaseRevId).toBe(mem.revisions[0]!.id);
    expect(await code(site.saveSiteDraft(d, 0, edited))).toBe("STALE_DRAFT");
    expect(await site.saveSiteDraft(d, 1, DEFAULT_SITE)).toMatchObject({
      draftVersion: 2,
    });
    expect(mem.revisions).toHaveLength(1); // within 5 minutes: no new autosnapshot
    const state = await site.getSiteState(d);
    expect(state.changes).toEqual([]);
  });

  it("autosnapshots the previous draft after 5 minutes", async () => {
    const { d, mem, advance } = setup();
    const a = withCmsTest(DEFAULT_SITE);
    await site.saveSiteDraft(d, 0, a);
    advance(AUTOSNAPSHOT_AFTER_MS + 1);
    await site.saveSiteDraft(d, 1, {
      ...a,
      swatches: [{ _key: "s1", hex: "#123456" }],
    });
    expect(mem.revisions.map((r) => r.kind)).toEqual([
      "autosnapshot",
      "autosnapshot",
    ]);
    expect(mem.revisions[1]!.docJson).toEqual(a);
    expect(mem.revisions[1]!.summary).toBe("Nav: added “CMS Test”");
  });

  it("refuses an invalid doc", async () => {
    const { d } = setup();
    const bad = structuredClone(DEFAULT_SITE);
    bad.nav.links[0]!.href = "javascript:alert(1)";
    expect(await code(site.saveSiteDraft(d, 0, bad))).toBe("INVALID_DOC");
    expect(
      await code(site.saveSiteDraft(d, 0, { ...DEFAULT_SITE, extra: 1 }))
    ).toBe("INVALID_DOC");
  });

  it("publishes to KV `site` with a diff summary, and the public read sees it", async () => {
    const { d, store } = setup();
    expect(await code(site.publishSite(d, 0))).toBe("NOT_FOUND");
    await site.saveSiteDraft(d, 0, withCmsTest(DEFAULT_SITE));
    expect((await site.getSiteState(d)).changes).toEqual([
      "Nav: added “CMS Test”",
    ]);
    const res = await site.publishSite(d, 1);
    expect(res).toMatchObject({
      ok: true,
      live: true,
      summary: "Nav: added “CMS Test”",
    });
    const live = JSON.parse(store.get(SITE_KV_KEY)!) as LiveSite;
    expect(live.revId).toBe(res.revId);
    expect(live.doc.nav.links.at(-1)?.href).toBe("/cms-test");
    const state = await site.getSiteState(d);
    expect(state).toMatchObject({ liveRevId: res.revId, changes: [] });
    const pub = await readSite(d.kv);
    expect(pub?.nav.links.map((l) => l.label)).toContain("CMS Test");
    expect(pub).not.toHaveProperty("swatches");
    expect(await code(site.publishSite(d, 0))).toBe("STALE_DRAFT");
  });

  it("reports a failed KV write as not live, and republish repairs it", async () => {
    const { d, kv, store } = setup({ failPuts: true });
    await site.saveSiteDraft(d, 0, withCmsTest(DEFAULT_SITE));
    const res = await site.publishSite(d, 1);
    expect(res.live).toBe(false);
    expect(store.has(SITE_KV_KEY)).toBe(false);
    kv.failPuts = false;
    expect(await site.republishSite(d)).toMatchObject({
      live: true,
      revId: res.revId,
    });
    expect(store.has(SITE_KV_KEY)).toBe(true);
  });

  it("restores an older version into the draft as a new revision; publishing it puts the defaults back live", async () => {
    const { d, mem, store } = setup();
    await site.saveSiteDraft(d, 0, withCmsTest(DEFAULT_SITE));
    await site.publishSite(d, 1);
    const before = mem.revisions.length;
    const original = mem.revisions[0]!; // the defaults, kept by the first save
    const restored = await site.restoreSite(d, original.id, 1);
    expect(restored.doc).toEqual(DEFAULT_SITE);
    expect(restored.draftVersion).toBe(2);
    expect(mem.revisions.length).toBe(before + 1); // the draft already matched the latest revision: no snapshot
    expect(mem.revisions.at(-1)).toMatchObject({ kind: "restore" });
    expect(mem.revisions.at(-1)!.summary).toMatch(
      /^Restored version from .* · Nav: removed “CMS Test”$/
    );
    expect((await site.getSiteState(d)).changes).toEqual([
      "Nav: removed “CMS Test”",
    ]);
    await site.publishSite(d, 2);
    expect((JSON.parse(store.get(SITE_KV_KEY)!) as LiveSite).doc).toEqual(
      DEFAULT_SITE
    );
    expect(mem.revisions.map((r) => r.kind)).toEqual([
      "autosnapshot",
      "published",
      "restore",
      "published",
    ]);
    expect(await code(site.restoreSite(d, "nope", 2))).toBe("NOT_FOUND");
    expect(await code(site.restoreSite(d, original.id, 1))).toBe("STALE_DRAFT");
  });

  it("replays a save whose response was lost (same batchId) instead of refusing it as stale", async () => {
    const { d, mem } = setup();
    const a = withCmsTest(DEFAULT_SITE);
    await site.saveSiteDraft(d, 0, a, "b1");
    expect(mem.row?.lastBatchId).toBe("b1");
    // The retry: same id, version and doc. The stored draft comes back, nothing is written.
    expect(await site.saveSiteDraft(d, 0, a, "b1")).toEqual({
      draftVersion: 1,
      doc: a,
    });
    expect(mem.row?.draftVersion).toBe(1);
    const b = { ...a, swatches: [{ _key: "s1", hex: "#123456" }] };
    await site.saveSiteDraft(d, 1, b, "b2");
    expect(await site.saveSiteDraft(d, 1, b, "b2")).toEqual({
      draftVersion: 2,
      doc: b,
    });
    // Not the last batch any more, another id, or no id: stale.
    expect(await code(site.saveSiteDraft(d, 0, a, "b1"))).toBe("STALE_DRAFT");
    expect(await code(site.saveSiteDraft(d, 1, b, "other"))).toBe(
      "STALE_DRAFT"
    );
    expect(await code(site.saveSiteDraft(d, 1, b))).toBe("STALE_DRAFT");
    await site.saveSiteDraft(d, 2, a);
    expect(mem.row?.lastBatchId).toBeNull();
  });

  it("saves a named version of the saved draft", async () => {
    const { d, mem } = setup();
    expect(await code(site.saveSiteVersion(d, "Before launch", 0))).toBe(
      "NOT_FOUND"
    );
    await site.saveSiteDraft(d, 0, withCmsTest(DEFAULT_SITE));
    expect(await code(site.saveSiteVersion(d, "Before launch", 0))).toBe(
      "STALE_DRAFT"
    );
    const { revId } = await site.saveSiteVersion(d, "Before launch", 1);
    expect(mem.revisions.at(-1)).toMatchObject({
      id: revId,
      kind: "named",
      label: "Before launch",
      summary: "Nav: added “CMS Test”",
      author: "user_1",
    });
    expect(mem.revisions.at(-1)!.docJson).toEqual(withCmsTest(DEFAULT_SITE));
    expect(mem.row).toMatchObject({ draftBaseRevId: revId, draftVersion: 1 });
    const { revisions } = await site.siteHistory(d, { limit: 10, offset: 0 });
    expect(revisions[0]).toMatchObject({
      kind: "named",
      label: "Before launch",
    });
    // Restoring it names it.
    await site.restoreSite(d, revId, 1);
    expect(mem.revisions.at(-1)!.summary).toMatch(
      /^Restored “?"Before launch"/
    );
  });

  it("snapshots the saved draft before a destructive edit, unless history already has it", async () => {
    const { d, mem } = setup();
    expect(await site.snapshotSite(d, 0, "Before removing a column")).toEqual({
      revId: null,
    }); // nothing edited yet
    await site.saveSiteDraft(d, 0, withCmsTest(DEFAULT_SITE));
    const { revId } = await site.snapshotSite(
      d,
      1,
      "Before removing “Services”"
    );
    expect(revId).not.toBeNull();
    expect(mem.revisions.at(-1)).toMatchObject({
      id: revId,
      kind: "autosnapshot",
      summary: "Before removing “Services” · Nav: added “CMS Test”",
    });
    expect(mem.revisions.at(-1)!.docJson).toEqual(withCmsTest(DEFAULT_SITE));
    expect(mem.row?.draftVersion).toBe(1); // the draft itself is unchanged
    // The latest revision is the draft now: no second snapshot.
    expect(await site.snapshotSite(d, 1, "Again")).toEqual({ revId: null });
    expect(await code(site.snapshotSite(d, 0, "Stale"))).toBe("STALE_DRAFT");
  });

  it("snapshots an unsaved-to-history draft before restoring over it", async () => {
    const { d, mem } = setup();
    await site.saveSiteDraft(d, 0, withCmsTest(DEFAULT_SITE));
    const first = mem.revisions[0]!.id;
    await site.restoreSite(d, first, 1);
    expect(mem.revisions.map((r) => r.kind)).toEqual([
      "autosnapshot",
      "autosnapshot",
      "restore",
    ]);
    expect(mem.revisions[1]!.docJson.nav.links.at(-1)?.label).toBe("CMS Test");
  });
});

describe("readSite (public read)", () => {
  const kvWith = (value: string | null | Error) => ({
    get: async () => {
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
  });

  it("falls back to the defaults (null) on a miss, a KV error, corrupt JSON or an invalid doc", async () => {
    expect(await readSite(kvWith(null))).toBeNull();
    expect(await readSite(kvWith(new Error("KV down")))).toBeNull();
    expect(await readSite(kvWith("{not json"))).toBeNull();
    const bad = structuredClone(DEFAULT_SITE);
    bad.seo.titleTemplate = "no placeholder";
    expect(
      await readSite(
        kvWith(JSON.stringify({ revId: "r", publishedAt: "", doc: bad }))
      )
    ).toBeNull();
  });

  it("returns the public part of a valid published doc: no swatches, no organization", async () => {
    const doc = {
      ...withCmsTest(DEFAULT_SITE),
      swatches: [{ _key: "a", hex: "#abcdef" }],
    };
    const pub = await readSite(
      kvWith(JSON.stringify({ revId: "r", publishedAt: "", doc }))
    );
    const { organization: _, ...seo } = doc.seo;
    expect(pub).toEqual({ nav: doc.nav, footer: doc.footer, seo });
    expect(pub?.seo).not.toHaveProperty("organization");
  });

  it("reads through the edge cache, and parses and validates a value once per isolate", async () => {
    const raw = JSON.stringify({
      revId: "r2",
      publishedAt: "",
      doc: withCmsTest(DEFAULT_SITE),
    });
    const get = mock(async () => raw);
    const parse = spyOn(JSON, "parse");
    try {
      const a = await readSite({ get });
      const b = await readSite({ get });
      expect(get).toHaveBeenCalledWith(SITE_KV_KEY, {
        cacheTtl: SITE_CACHE_TTL_S,
      });
      expect(SITE_CACHE_TTL_S).toBe(60);
      expect(parse.mock.calls.filter(([v]) => v === raw)).toHaveLength(1);
      expect(b?.nav).toBe(a?.nav);
    } finally {
      parse.mockRestore();
    }
  });

  it("readSiteSeo: the published SEO defaults with the organization, fresh (no edge cache), or the built-in ones", async () => {
    const doc = withCmsTest(DEFAULT_SITE);
    doc.seo.titleTemplate = "%s — Example";
    const get = mock(async () =>
      JSON.stringify({ revId: "r3", publishedAt: "", doc })
    );
    expect(await readSiteSeo({ get }, TEST_CONFIG)).toEqual(doc.seo);
    expect(get).toHaveBeenCalledWith(SITE_KV_KEY, undefined);
    expect(await readSiteSeo(kvWith(null), TEST_CONFIG)).toEqual(
      DEFAULT_SITE.seo
    );
    expect(
      (await readSiteSeo(kvWith(new Error("down")), TEST_CONFIG)).organization
        .name
    ).toBe(TEST_CONFIG.name);
  });
});
