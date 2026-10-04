import { summarizeChange } from "@repo/cms-core/ops/summary";
import { nanoid } from "nanoid";
import { CmsError, type ServiceDeps } from "../cms/pages-service";
import type { RevisionRow } from "../cms/repo";

/**
 * Records an accepted agent changeset in the page's history (docs/cms-plan.md §3.2, §4.4): an
 * `agent` revision of the draft as saved after the accept, tagged with the thread id
 * (`agent_run_id`). Like "Save version", it doesn't touch the draft itself, and with `draftVersion`
 * it refuses (STALE_DRAFT) unless that is still the draft, so the revision is exactly what the
 * editor saved. Kept beside the page service (which it uses through the same repo) rather than in it.
 */
export async function recordAgentRevision(
  d: ServiceDeps,
  input: {
    pageId: string;
    draftVersion: number;
    summary: string;
    runId: string;
  }
): Promise<RevisionRow> {
  const page = await d.repo.findPage({ id: input.pageId });
  if (!page) {
    throw new CmsError("NOT_FOUND", `page ${input.pageId} not found`);
  }
  if (page.status === "archived") {
    throw new CmsError("ARCHIVED", `page ${page.id} is archived`);
  }
  if (page.draftVersion !== input.draftVersion) {
    throw new CmsError("STALE_DRAFT", "The draft changed since; reload it.");
  }
  if (!page.draftDoc) {
    throw new CmsError("NOT_FOUND", `page ${page.id} has no draft`);
  }
  const doc = page.draftDoc;
  const latest = await d.repo.latestRevision(page.id);
  const change = summarizeChange(
    latest?.docJson ?? { ...doc, blocks: [] },
    doc,
    d.labelFor
  );
  const rev: RevisionRow = {
    id: (d.genId ?? (() => nanoid()))(),
    pageId: page.id,
    parentRevId: page.draftBaseRevId,
    docJson: doc,
    kind: "agent",
    label: null,
    summary: `Agent: ${input.summary}${change ? ` · ${change}` : ""}`.slice(
      0,
      1000
    ),
    author: d.author ?? null,
    agentRunId: input.runId,
    createdAt: new Date((d.now ?? Date.now)()),
  };
  const committed = await d.repo.commit(page.id, [rev], {
    draftBaseRevId: rev.id,
    ifDraftVersion: input.draftVersion,
  });
  if (!committed) {
    throw new CmsError("STALE_DRAFT", "The draft changed since; reload it.");
  }
  return rev;
}
