// biome-ignore-all lint/style/noNonNullAssertion: row is checked just above (ported verbatim from the source).
// biome-ignore-all lint/suspicious/useAwait: the methods are async to implement SiteRepo; arrays need no awaiting.
import type { SiteRepo, SiteRevisionRow, SiteRow } from "../cms/site-repo";

/** In-memory `SiteRepo` for tests; mirrors the D1 compare-and-set rules. */
export function createSiteMemoryRepo() {
  let row: SiteRow | null = null;
  const revisions: SiteRevisionRow[] = [];
  const clone = structuredClone;

  const repo: SiteRepo = {
    async get() {
      return row ? clone(row) : null;
    },
    async create(r, revs) {
      if (row) {
        return false;
      }
      row = clone(r);
      revisions.push(...clone(revs));
      return true;
    },
    async commit(revs, patch) {
      if (patch && !row) {
        throw new Error("no site row");
      }
      if (
        patch?.ifDraftVersion !== undefined &&
        row!.draftVersion !== patch.ifDraftVersion
      ) {
        return false;
      }
      if (row && patch) {
        const { bumpDraftVersion, ifDraftVersion: _, ...fields } = patch;
        row = { ...row, ...clone(fields) };
        if (bumpDraftVersion) {
          row.draftVersion += 1;
        }
      }
      revisions.push(...clone(revs));
      return true;
    },
    async latestRevision() {
      const r = revisions.at(-1);
      return r ? clone(r) : null;
    },
    async listRevisions({ limit, offset }) {
      return [...revisions]
        .reverse()
        .slice(offset, offset + limit)
        .map(({ docJson: _doc, ...m }) => clone(m));
    },
    async getRevision(id) {
      const r = revisions.find((x) => x.id === id);
      return r ? clone(r) : null;
    },
  };
  return {
    repo,
    revisions,
    get row() {
      return row;
    },
  };
}
