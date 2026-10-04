import { describe, expect, it } from "bun:test";

import { createD1MediaRepo, mediaSizes } from "./media.ts";
import type { MediaRow } from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

const m = (id: string, over: Partial<MediaRow> = {}): MediaRow => ({
  id,
  r2Key: `media/${id}`,
  sha256: id.repeat(64).slice(0, 64),
  mime: "image/png",
  width: 10,
  height: 20,
  alt: null,
  tags: null,
  source: "upload",
  createdAt: new Date(1000),
  ...over,
});

describe("media table", () => {
  it("insert is idempotent and get returns the row", async () => {
    const { db } = createTestDb();
    const repo = createD1MediaRepo(db);
    await repo.insert(m("a1", { alt: "first" }));
    await repo.insert(m("a1", { alt: "second" }));
    expect((await repo.get("a1"))?.alt).toBe("first");
    expect(await repo.get("zz")).toBeNull();
  });

  it("lists newest first with a keyset cursor, hiding agent images unless asked", async () => {
    const { db } = createTestDb();
    const repo = createD1MediaRepo(db);
    await repo.insert(m("a1", { createdAt: new Date(1) }));
    await repo.insert(m("b2", { createdAt: new Date(2) }));
    await repo.insert(m("c3", { createdAt: new Date(2) }));
    await repo.insert(m("d4", { createdAt: new Date(3), source: "agent" }));
    expect((await repo.list({ limit: 10 })).map((r) => r.id)).toEqual([
      "c3",
      "b2",
      "a1",
    ]);
    expect(
      (await repo.list({ limit: 10, includeAgent: true })).map((r) => r.id)
    ).toEqual(["d4", "c3", "b2", "a1"]);
    expect(
      (await repo.list({ limit: 10, after: { createdAt: 2, id: "c3" } })).map(
        (r) => r.id
      )
    ).toEqual(["b2", "a1"]);
  });

  it("searches alt, id and each tag case-insensitively, but not JSON punctuation", async () => {
    const { db } = createTestDb();
    const repo = createD1MediaRepo(db);
    await repo.insert(
      m("a1", { alt: "Sunset over HILLS", tags: ["beach", "Dusk"] })
    );
    await repo.insert(m("b2", { alt: null, tags: ["city"] }));
    const ids = async (query: string) =>
      (await repo.list({ query, limit: 10 })).map((r) => r.id);
    expect(await ids("hills")).toEqual(["a1"]);
    expect(await ids("DUSK")).toEqual(["a1"]);
    expect(await ids("b2")).toEqual(["b2"]);
    expect(await ids('","')).toEqual([]);
  });

  it("updates alt and tags, reporting whether the row exists", async () => {
    const { db } = createTestDb();
    const repo = createD1MediaRepo(db);
    await repo.insert(m("a1", { tags: ["x"] }));
    expect(await repo.update("a1", { alt: "new" })).toBe(true);
    expect(await repo.get("a1")).toMatchObject({ alt: "new", tags: ["x"] });
    expect(await repo.update("a1", { alt: null, tags: ["y", "z"] })).toBe(true);
    expect(await repo.get("a1")).toMatchObject({ alt: null, tags: ["y", "z"] });
    expect(await repo.update("nope", { alt: "x" })).toBe(false);
  });

  it("reads stored sizes for the ids asked for, in chunks under the parameter limit", async () => {
    const { db, log } = createTestDb();
    const repo = createD1MediaRepo(db);
    await repo.insert(m("a1", { width: 640, height: 480 }));
    const ids = ["a1", ...Array.from({ length: 200 }, (_, i) => `x${i}`)];
    expect(await mediaSizes(db, ids)).toEqual({
      a1: { width: 640, height: 480 },
    });
    expect(Math.max(...log.map((l) => l.params))).toBeLessThanOrEqual(100);
  });
});
