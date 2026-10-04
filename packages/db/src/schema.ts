// The tables. `drizzle-kit generate` diffs this file against the last snapshot
// in migrations/, so every change here needs a new migration generated with it.
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * Any drizzle SQLite instance, which is what every query function takes. D1
 * (`drizzle-orm/d1`) is async and `bun:sqlite` (`drizzle-orm/bun-sqlite`, used
 * by the tests) is sync; both satisfy this, and awaiting works either way.
 */
export type Database = BaseSQLiteDatabase<"sync" | "async", unknown>;

// TODO(cms-port): the CMS tables (pages, site, posts, media, api keys, ...) go here.
