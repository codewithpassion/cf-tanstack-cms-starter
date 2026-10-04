import { describe, expect, it } from "bun:test";

import { GSC_CONNECT_HINT } from "@repo/cms-core/gsc/shape";
import { gscInspections, pages, revisions } from "@repo/db";
import { createD1Repo } from "@repo/db/pages";
import { createTestDb } from "@repo/db/test-utils";

import { createGscAdmin, type GscAdminDeps, sitemapUrl } from "./admin";
import { type GscClient, GscError } from "./client";
import { createD1GscQueries, createD1GscStore } from "./d1";

const U = "https://example.com";
const config = { origin: U };
const NOW = new Date("2026-10-02T00:00:00Z");

type Db = ReturnType<typeof createTestDb>["db"];

async function seedPage(db: Db, slug: string, status: "draft" | "published") {
  const id = `p-${slug}`;
  const doc = { _schema: 1, seo: {}, blocks: [] } as never;
  await db.insert(pages).values({
    id,
    kind: "page",
    slug,
    title: slug,
    status,
    draftDoc: doc,
    liveRevId: status === "published" ? `r-${id}` : null,
    updatedAt: NOW,
  });
  if (status === "published") {
    await db.insert(revisions).values({
      id: `r-${id}`,
      pageId: id,
      docJson: doc,
      kind: "published",
      createdAt: NOW,
    });
  }
  return id;
}

function setup(client: GscClient | null) {
  const { db } = createTestDb();
  const deps: GscAdminDeps = {
    queries: createD1GscQueries(db),
    pages: createD1Repo(db),
    store: createD1GscStore(db),
    client,
    config,
    clock: () => NOW,
  };
  return { db, admin: createGscAdmin(deps) };
}

const fakeClient = (over: Partial<GscClient> = {}): GscClient => ({
  searchAnalytics: () => Promise.resolve([]),
  inspectUrl: () => Promise.resolve({ verdict: "PASS" }),
  submitSitemap: () => Promise.resolve(),
  ...over,
});

describe("gsc admin", () => {
  it("reads a page's performance on the site origin and says whether GSC is connected", async () => {
    const { db, admin } = setup(null);
    const id = await seedPage(db, "about", "published");
    const result = await admin.pagePerformance({ pageId: id, days: 28 });
    expect(result).toMatchObject({
      ok: true,
      connected: false,
      performance: { url: `${U}/about`, range: null },
    });
  });

  it("answers NOT_FOUND for an unknown page and rejects bad input", async () => {
    const { admin } = setup(null);
    expect(await admin.pagePerformance({ pageId: "nope", days: 28 })).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Page nope not found",
    });
    await expect(
      admin.pagePerformance({ pageId: "x", days: 7 })
    ).rejects.toThrow('"days"');
    await expect(admin.seoOverview({ minImpressions: -1 })).rejects.toThrow(
      '"minImpressions"'
    );
  });

  it("builds the overview", async () => {
    const { admin } = setup(fakeClient());
    expect(await admin.seoOverview()).toMatchObject({
      ok: true,
      connected: true,
      gsc: { range: null, minImpressions: 10 },
    });
  });

  it("inspects a published page now and stores the result", async () => {
    const { db, admin } = setup(fakeClient());
    const id = await seedPage(db, "about", "published");
    expect(await admin.inspectPageNow({ pageId: id })).toEqual({
      ok: true,
      inspected: true,
    });
    const [row] = await db.select().from(gscInspections);
    expect(row).toMatchObject({ page: `${U}/about`, checkedAt: NOW });
  });

  it("refuses drafts, needs a client, and shows Search Console failures", async () => {
    const draft = setup(fakeClient());
    const draftId = await seedPage(draft.db, "wip", "draft");
    expect(await draft.admin.inspectPageNow({ pageId: draftId })).toMatchObject(
      { ok: false }
    );

    const offline = setup(null);
    const id = await seedPage(offline.db, "about", "published");
    expect(await offline.admin.inspectPageNow({ pageId: id })).toEqual({
      ok: false,
      message: GSC_CONNECT_HINT,
    });

    const quota = setup(
      fakeClient({
        inspectUrl: () =>
          Promise.reject(new GscError("RATE_LIMITED", "quota", 429)),
      })
    );
    const qid = await seedPage(quota.db, "about", "published");
    expect(await quota.admin.inspectPageNow({ pageId: qid })).toMatchObject({
      ok: false,
    });
  });

  it("resubmits the sitemap on the site origin; a read-only sign-in gets the re-auth hint", async () => {
    const submitted: string[] = [];
    const ok = setup(
      fakeClient({
        submitSitemap: (url) => {
          submitted.push(url);
          return Promise.resolve();
        },
      })
    );
    expect(await ok.admin.submitSitemap()).toEqual({ ok: true });
    expect(submitted).toEqual([sitemapUrl(config)]);
    expect(sitemapUrl(config)).toBe(`${U}/sitemap.xml`);

    const readOnly = setup(
      fakeClient({
        submitSitemap: () =>
          Promise.reject(
            new GscError("FORBIDDEN", "Request had insufficient scopes", 403)
          ),
      })
    );
    const result = await readOnly.admin.submitSitemap();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("gsc:auth");
  });
});
