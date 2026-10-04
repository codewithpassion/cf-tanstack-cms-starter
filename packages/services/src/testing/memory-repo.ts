// biome-ignore-all lint/suspicious/useAwait: the methods are async to implement CmsRepo; arrays need no awaiting.
import { comparePosts } from "../cms/pages-service";
import {
  ChangesetDecided,
  type ChangesetDecision,
  type CmsRepo,
  type PageRow,
  type RevisionListRow,
  type RevisionRow,
} from "../cms/repo";

/**
 * In-memory `CmsRepo` for tests. Mirrors the D1 constraints the service relies on: unique
 * non-archived slugs, append-only revisions, compare-and-set draft saves, all-or-nothing commits.
 * Rows are cloned on the way in and out so callers can't mutate stored state. `decideChangeset`
 * stands in for the agent's changesets table in a commit that decides a run proposal: it decides
 * synchronously (false when the proposal isn't pending), see `createMemoryAgentStore().decideNow`.
 */
export function createMemoryRepo(
  opts: { decideChangeset?: (d: ChangesetDecision) => boolean } = {}
) {
  const pages: PageRow[] = [];
  const revisions: RevisionRow[] = [];
  const labels = new Map<string, { label: string | null; pinned: boolean }>();
  const clone = structuredClone;

  const listed = (pageId: string): RevisionListRow[] =>
    revisions
      .filter((r) => r.pageId === pageId)
      .reverse()
      .map(({ docJson: _doc, ...meta }) => {
        const l = labels.get(meta.id);
        return {
          ...clone(meta),
          label: l?.label ?? meta.label,
          pinned: l?.pinned ?? false,
        };
      });

  const slugTaken = (slug: string, exceptId: string) =>
    pages.some(
      (p) => p.slug === slug && p.status !== "archived" && p.id !== exceptId
    );

  const repo: CmsRepo = {
    async findPage(ref) {
      const row =
        "id" in ref
          ? pages.find((p) => p.id === ref.id)
          : pages.find((p) => p.slug === ref.slug && p.status !== "archived");
      return row ? clone(row) : null;
    },

    async insertPage(row) {
      if (pages.some((p) => p.id === row.id)) {
        throw new Error("UNIQUE constraint failed: pages.id");
      }
      if (slugTaken(row.slug, row.id)) {
        throw new Error("UNIQUE constraint failed: pages.slug");
      }
      pages.push(clone(row));
    },

    async listPages() {
      return [...pages]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map(({ draftDoc: _doc, ...meta }) => clone(meta));
    },

    async saveDraft(id, expectedVersion, doc, updatedAt, batchId = null) {
      const page = pages.find((p) => p.id === id);
      if (!page || page.draftVersion !== expectedVersion) {
        return false;
      }
      Object.assign(page, {
        draftDoc: clone(doc),
        draftVersion: expectedVersion + 1,
        lastBatchId: batchId,
        updatedAt,
      });
      return true;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mirrors every D1 commit constraint in one place.
    async commit(pageId, revs, patch, decide) {
      const page = pages.find((p) => p.id === pageId);
      if (patch && !page) {
        throw new Error(`no page ${pageId}`);
      }
      if (
        patch?.ifDraftVersion !== undefined &&
        page?.draftVersion !== patch.ifDraftVersion
      ) {
        return false;
      }
      if (revs.some((r) => revisions.some((x) => x.id === r.id))) {
        throw new Error("UNIQUE constraint failed: revisions.id");
      }
      let next: PageRow | null = null;
      if (page && patch) {
        const { bumpDraftVersion, ifDraftVersion: _, ...fields } = patch;
        next = { ...page, ...clone(fields) };
        if (slugTaken(next.slug, pageId) && next.status !== "archived") {
          throw new Error("UNIQUE constraint failed: pages.slug");
        }
        if (bumpDraftVersion) {
          next.draftVersion += 1;
        }
      }
      // Last check before writing: the decision is written only if everything else will be.
      if (decide) {
        if (!opts.decideChangeset) {
          throw new Error("memory repo: no decideChangeset hook");
        }
        if (!opts.decideChangeset(decide)) {
          throw new ChangesetDecided();
        }
      }
      if (page && next) {
        Object.assign(page, next);
      }
      revisions.push(...clone(revs));
      return true;
    },

    async latestRevision(pageId) {
      const row = revisions.filter((r) => r.pageId === pageId).at(-1);
      return row ? clone(row) : null;
    },

    async listRevisions(pageId) {
      return revisions
        .filter((r) => r.pageId === pageId)
        .reverse()
        .map(({ docJson: _doc, ...meta }) => clone(meta));
    },

    async getRevision(id) {
      const row = revisions.find((r) => r.id === id);
      return row ? clone(row) : null;
    },

    async runRevisions(agentRunId) {
      return revisions
        .filter((r) => r.agentRunId === agentRunId && r.kind === "agent")
        .map(({ docJson: _doc, ...meta }) => clone(meta));
    },

    async revisionLabel(id) {
      const row = revisions.find((r) => r.id === id);
      return labels.get(id)?.label ?? row?.label ?? null;
    },

    async listRevisionPage(pageId, { limit, offset }) {
      return listed(pageId).slice(offset, offset + limit);
    },

    async pinnedRevisions(pageId) {
      return listed(pageId).filter((r) => r.pinned);
    },

    async labelRevision(revId, patch, _at) {
      if (!revisions.some((r) => r.id === revId)) {
        throw new Error("FOREIGN KEY constraint failed");
      }
      const prev = labels.get(revId) ?? { label: null, pinned: false };
      labels.set(revId, {
        label: patch.label === undefined ? prev.label : patch.label,
        pinned: patch.pinned ?? prev.pinned,
      });
    },

    async publishedSlugs(pageId) {
      const slugs = revisions
        .filter((r) => r.pageId === pageId && r.kind === "published")
        .map((r) => r.docJson.seo.slug);
      return [...new Set(slugs)];
    },

    async livePosts() {
      return pages
        .filter((p) => p.kind === "post" && p.status === "published")
        .flatMap((p) => {
          const rev = revisions.find((r) => r.id === p.liveRevId);
          return rev
            ? [
                {
                  page: clone(p),
                  doc: clone(rev.docJson),
                  publishedAt: rev.createdAt,
                },
              ]
            : [];
        })
        .sort((a, b) =>
          comparePosts(
            { slug: a.page.slug, publishedAt: a.doc.post?.publishedAt ?? "" },
            { slug: b.page.slug, publishedAt: b.doc.post?.publishedAt ?? "" }
          )
        );
    },

    async livePages() {
      return pages
        .filter((p) => p.status === "published")
        .flatMap((p) => {
          const rev = revisions.find((r) => r.id === p.liveRevId);
          return rev
            ? [
                {
                  page: clone(p),
                  doc: clone(rev.docJson),
                  publishedAt: rev.createdAt,
                },
              ]
            : [];
        });
    },
  };

  return { repo, pages, revisions };
}
