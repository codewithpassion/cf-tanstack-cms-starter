// biome-ignore-all lint/performance/noAwaitInLoops: a D1 batch runs its statements in order, inside one transaction.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import type { D1Db } from "./schema.ts";
// biome-ignore lint/performance/noNamespaceImport: drizzle takes the whole schema object.
import * as schema from "./schema.ts";

/**
 * Test helper (bun only, never imported by app code): a real SQLite database (`bun:sqlite`, in
 * memory) behind the D1 API, with every migration in `migrations/` applied, so tests run the
 * actual Drizzle SQL and the real migrations rather than mocks. `drizzle-orm/bun-sqlite` has no
 * `batch`, so the stand-in speaks D1 instead: it covers what `drizzle-orm/d1` calls (prepare, bind,
 * all/run/raw/first) and `batch`, which runs its statements in one transaction and rolls back on
 * the first failure, as D1 does. That is what lets the compare-and-set guards be tested.
 */

type Row = Record<string, unknown>;
type Bindable = string | number | bigint | boolean | null | Uint8Array;

/** packages/db/migrations, wherever `bun test` runs from. */
const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

export function createTestDb() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS_DIR, file), "utf8").split(
      "--> statement-breakpoint"
    )) {
      if (stmt.trim()) {
        sqlite.run(stmt);
      }
    }
  }

  /** Every statement run, with its bound parameter count (D1 allows 100). */
  const log: { sql: string; params: number }[] = [];
  const bindable = (v: unknown): Bindable => {
    if (typeof v === "boolean") {
      return v ? 1 : 0;
    }
    return v === undefined ? null : (v as Bindable);
  };

  function statement(sql: string, params: unknown[] = []) {
    const prepared = () => {
      log.push({ sql, params: params.length });
      return sqlite.prepare(sql);
    };
    const values = params.map(bindable);
    return {
      bind: (...p: unknown[]) => statement(sql, p),
      all() {
        return Promise.resolve({
          results: prepared().all(...values) as Row[],
          success: true,
          meta: {},
        });
      },
      run() {
        const info = prepared().run(...values);
        return Promise.resolve({
          results: [],
          success: true,
          meta: { changes: Number(info.changes) },
        });
      },
      raw() {
        return Promise.resolve(prepared().values(...values));
      },
      first() {
        return Promise.resolve(
          (prepared().all(...values)[0] as Row | undefined) ?? null
        );
      },
    };
  }

  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: ReturnType<typeof statement>[]) {
      sqlite.run("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of stmts) {
          out.push(await s.all());
        }
        sqlite.run("COMMIT");
        return out;
      } catch (err) {
        sqlite.run("ROLLBACK");
        throw err;
      }
    },
  };

  const db: D1Db = drizzle(d1 as unknown as Parameters<typeof drizzle>[0], {
    schema,
  });
  return { db, sqlite, log, d1 };
}
