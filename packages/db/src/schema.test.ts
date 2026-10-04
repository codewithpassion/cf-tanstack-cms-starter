import { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database } from "./schema.ts";

// TODO(cms-port): replaced by per-table tests that apply the real migrations.
test("a bun:sqlite drizzle instance is a Database", async () => {
  const db: Database = drizzle(new SqliteDatabase(":memory:"));
  const rows = await db.all<{ one: number }>("select 1 as one");
  expect(rows).toEqual([{ one: 1 }]);
});
