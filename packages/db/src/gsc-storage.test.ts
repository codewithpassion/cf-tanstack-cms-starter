import { describe, expect, it } from "bun:test";

import {
  insertInspection,
  lastInspections,
  PAGE_DAYS_PER_INSERT,
  publishedPages,
  ROWS_PER_INSERT,
  replaceWindow,
  replaceWindowStatements,
} from "./gsc.ts";
import { gscPageDays, gscRows, pages, revisions } from "./schema.ts";
import { D1_MAX_PARAMS } from "./shared.ts";
import { createTestDb } from "./test-utils.ts";

const U = "https://example.com";
const pageUrl = (slug: string) => `${U}/${slug}`;

const qRow = (date: string, page: string, query: string, impressions = 10) => ({
  date,
  page,
  query,
  device: "DESKTOP",
  clicks: 1,
  impressions,
  ctr: 1 / impressions,
  position: 5,
});
const pRow = (date: string, page: string, impressions = 10) => ({
  date,
  page,
  clicks: 2,
  impressions,
  ctr: 2 / impressions,
  position: 4.5,
});

describe("replaceWindowStatements", () => {
  it("keeps every insert under D1's 100 bound parameters", () => {
    const { db } = createTestDb();
    const rows = Array.from({ length: 1000 }, (_, i) =>
      qRow("2026-09-01", `${U}/p${i}`, `q${i}`, 1)
    );
    const days = Array.from({ length: 1000 }, (_, i) =>
      pRow("2026-09-01", `${U}/p${i}`, 1)
    );
    const statements = replaceWindowStatements(
      db,
      "2026-09-01",
      "2026-09-10",
      rows,
      days
    );
    const params = statements.map((s) => s.toSQL().params.length);
    expect(Math.max(...params)).toBeLessThanOrEqual(D1_MAX_PARAMS);
    expect(ROWS_PER_INSERT).toBe(12);
    expect(PAGE_DAYS_PER_INSERT).toBe(16);
    // 2 deletes + ceil(1000/12) + ceil(1000/16)
    expect(statements).toHaveLength(2 + 84 + 63);
  });
});

describe("replaceWindow", () => {
  it("replaces the window: revised values update, dropped rows go, rows outside stay", async () => {
    const { db } = createTestDb();
    await replaceWindow(
      db,
      "2026-08-25",
      "2026-09-10",
      [
        qRow("2026-08-31", `${U}/`, "old"),
        qRow("2026-09-02", `${U}/`, "gone"),
        qRow("2026-09-03", `${U}/`, "kept"),
      ],
      [pRow("2026-08-31", `${U}/`), pRow("2026-09-02", `${U}/`)]
    );
    const statements = await replaceWindow(
      db,
      "2026-09-01",
      "2026-09-10",
      [qRow("2026-09-03", `${U}/`, "kept", 25)],
      [pRow("2026-09-03", `${U}/`, 25)]
    );
    expect(statements).toBe(4);
    expect(
      await db
        .select({
          date: gscRows.date,
          query: gscRows.query,
          impressions: gscRows.impressions,
        })
        .from(gscRows)
        .orderBy(gscRows.date)
    ).toEqual([
      { date: "2026-08-31", query: "old", impressions: 10 },
      { date: "2026-09-03", query: "kept", impressions: 25 },
    ]);
    expect(
      (
        await db
          .select({ date: gscPageDays.date })
          .from(gscPageDays)
          .orderBy(gscPageDays.date)
      ).map((r) => r.date)
    ).toEqual(["2026-08-31", "2026-09-03"]);
  });

  it("upserts a duplicate key in the response instead of failing the batch", async () => {
    const { db } = createTestDb();
    await replaceWindow(
      db,
      "2026-09-01",
      "2026-09-10",
      [
        qRow("2026-09-03", `${U}/`, "dup", 5),
        qRow("2026-09-03", `${U}/`, "dup", 9),
      ],
      []
    );
    const rows = await db.select().from(gscRows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.impressions).toBe(9);
  });

  it("rolls the whole batch back when a statement fails", async () => {
    const { db } = createTestDb();
    await replaceWindow(
      db,
      "2026-09-01",
      "2026-09-10",
      [qRow("2026-09-03", `${U}/`, "kept")],
      []
    );
    // A null `page` violates NOT NULL in the last insert, after the window was deleted.
    const bad = { ...pRow("2026-09-03", `${U}/`), page: null as never };
    await expect(
      replaceWindow(db, "2026-09-01", "2026-09-10", [], [bad])
    ).rejects.toThrow();
    expect(await db.select().from(gscRows)).toHaveLength(1);
  });
});

describe("inspections and published pages", () => {
  it("lists indexable published pages with their publish time, skipping noindex and draft ones", async () => {
    const { db } = createTestDb();
    const seed = async (
      id: string,
      slug: string,
      status: "draft" | "published",
      index: boolean
    ) => {
      const doc = { seo: { robots: { index } } };
      await db.insert(pages).values({
        id,
        kind: "page",
        slug,
        title: id,
        status,
        draftDoc: doc,
        liveRevId: `${id}-r`,
        updatedAt: new Date(0),
      });
      await db.insert(revisions).values({
        id: `${id}-r`,
        pageId: id,
        docJson: doc,
        kind: "published",
        createdAt: new Date(1000),
      });
    };
    await seed("a", "about", "published", true);
    await seed("b", "hidden", "published", false);
    await seed("c", "wip", "draft", true);
    expect(await publishedPages(db, pageUrl)).toEqual([
      { url: `${U}/about`, publishedAt: 1000 },
    ]);
  });

  it("stores inspections and reports the newest check per URL", async () => {
    const { db } = createTestDb();
    await insertInspection(db, {
      page: `${U}/a`,
      checkedAt: new Date(1),
      verdict: "PASS",
    });
    await insertInspection(db, {
      page: `${U}/a`,
      checkedAt: new Date(5),
      verdict: "NEUTRAL",
    });
    await insertInspection(db, {
      page: `${U}/b`,
      checkedAt: new Date(2),
      verdict: "PASS",
    });
    expect(await lastInspections(db)).toEqual(
      new Map([
        [`${U}/a`, 5],
        [`${U}/b`, 2],
      ])
    );
  });
});
