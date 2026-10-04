// biome-ignore-all lint/style/noNestedTernary: moved verbatim from the source media service.
// biome-ignore-all lint/suspicious/useAwait: the methods are async to implement MediaRepo; arrays need no awaiting.
import type { MediaRow } from "@repo/db";
import type { MediaRepo } from "../cms/media-repo";

/** SQLite's `lower()`: ASCII letters only. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * True when `row` matches a search the way the D1 repo does: a case-insensitive (ASCII) substring
 * of the id, the alt text or any single tag.
 */
export function matchesQuery(row: MediaRow, query: string): boolean {
  const q = asciiLower(query);
  return [row.id, row.alt ?? "", ...(row.tags ?? [])].some((s) =>
    asciiLower(s).includes(q)
  );
}

/** Newest first: `created_at` desc, then `id` desc. */
function compareNewest(a: MediaRow, b: MediaRow): number {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** In-memory `MediaRepo` for tests. Rows are cloned in and out. */
export function createMemoryMediaRepo() {
  const rows: MediaRow[] = [];
  const clone = structuredClone;

  const repo: MediaRepo = {
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return row ? clone(row) : null;
    },
    async insert(row) {
      if (!rows.some((r) => r.id === row.id)) {
        rows.push(clone(row));
      }
    },
    async list({ query, after, limit, includeAgent }) {
      return rows
        .filter((r) => includeAgent || r.source !== "agent")
        .filter((r) => !query || matchesQuery(r, query))
        .filter(
          (r) =>
            !after ||
            r.createdAt.getTime() < after.createdAt ||
            (r.createdAt.getTime() === after.createdAt && r.id < after.id)
        )
        .sort(compareNewest)
        .slice(0, limit)
        .map((r) => clone(r));
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        return false;
      }
      row.alt = patch.alt;
      if (patch.tags !== undefined) {
        row.tags = clone(patch.tags);
      }
      return true;
    },
  };

  return { repo, rows };
}
