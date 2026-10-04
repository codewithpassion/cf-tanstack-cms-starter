import { describe, expect, it } from "bun:test";
import type { SiteRevisionRow, SiteRow } from "./schema.ts";
import { SITE_ID } from "./shared.ts";
import { createSiteD1Repo } from "./site.ts";
import { createTestDb } from "./test-utils.ts";

const at = (ms: number) => new Date(ms);
const row = (): SiteRow => ({
  id: SITE_ID,
  draftDoc: { name: "v0" },
  draftVersion: 0,
  draftBaseRevId: null,
  liveRevId: null,
  lastBatchId: null,
  updatedAt: at(1),
});
const rev = (id: string, createdAt = 10): SiteRevisionRow => ({
  id,
  parentRevId: null,
  docJson: { name: id },
  kind: "autosnapshot",
  label: null,
  summary: null,
  author: null,
  createdAt: at(createdAt),
});

describe("site repo", () => {
  it("creates the row once: a second create reports false and writes nothing", async () => {
    const { db } = createTestDb();
    const repo = createSiteD1Repo(db);
    expect(await repo.create(row(), [rev("r1")])).toBe(true);
    expect(await repo.create(row(), [rev("r2")])).toBe(false);
    expect(await repo.getRevision("r2")).toBeNull();
    expect((await repo.get())?.id).toBe(SITE_ID);
  });

  it("commits with compare-and-set on draft_version", async () => {
    const { db } = createTestDb();
    const repo = createSiteD1Repo(db);
    await repo.create(row(), []);
    expect(
      await repo.commit([rev("r1")], {
        draftDoc: { name: "v1" },
        bumpDraftVersion: true,
        ifDraftVersion: 0,
      })
    ).toBe(true);
    expect(await repo.get()).toMatchObject({
      draftVersion: 1,
      draftDoc: { name: "v1" },
    });
    // Stale: nothing written, not even the revision.
    expect(
      await repo.commit([rev("r2")], {
        draftDoc: { name: "v2" },
        ifDraftVersion: 0,
      })
    ).toBe(false);
    expect(await repo.getRevision("r2")).toBeNull();
    expect((await repo.get())?.draftDoc).toEqual({ name: "v1" });
  });

  it("rethrows a failure that is not a stale version", async () => {
    const { db } = createTestDb();
    const repo = createSiteD1Repo(db);
    await repo.create(row(), [rev("r1")]);
    await expect(
      repo.commit([rev("r1")], { draftDoc: { name: "x" }, ifDraftVersion: 0 })
    ).rejects.toThrow();
  });

  it("lists revisions newest first without documents", async () => {
    const { db } = createTestDb();
    const repo = createSiteD1Repo(db);
    await repo.create(row(), [rev("r1", 10), rev("r2", 10)]);
    await repo.commit([rev("r3", 20)]);
    const list = await repo.listRevisions({ limit: 2, offset: 0 });
    expect(list.map((r) => r.id)).toEqual(["r3", "r2"]);
    expect("docJson" in (list[0] ?? {})).toBe(false);
    expect((await repo.latestRevision())?.id).toBe("r3");
  });
});
