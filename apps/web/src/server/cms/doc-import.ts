import { slugToPath } from "@repo/cms-core/paths";
import type { PageDoc, PageKind } from "@repo/cms-core/types";
import type { PageStatus } from "@repo/services/cms/admin-result";
import {
  createPage,
  getPage,
  type ServiceDeps,
} from "@repo/services/cms/pages-service";

/**
 * Writes documents built in code into the CMS as drafts. Used by /admin/setup (the setup router,
 * inside the deployed Worker).
 *
 * Idempotent by slug: a page that is missing is created as a draft; a page that already exists at
 * the slug is left exactly as it is (never overwritten, never published), so a re-run, or a run
 * after the page was edited, changes nothing. The editor owns a page once it exists.
 */

export type ImportTarget = {
  kind: PageKind;
  slug: string;
  title: string;
  doc: () => PageDoc;
};

// TODO(cms-port): Phase 4 fills this with the starter content (home, about, contact, sample posts).
export const STARTER_IMPORT_TARGETS: ImportTarget[] = [];

/** The imports /admin/setup offers. */
export const SETUP_IMPORTS = {
  starter: (): ImportTarget[] => STARTER_IMPORT_TARGETS,
} as const;

export type SetupImport = keyof typeof SETUP_IMPORTS;

export const SETUP_IMPORT_NAMES = Object.keys(SETUP_IMPORTS) as [
  SetupImport,
  ...SetupImport[],
];

/** What a run would do to one document, or did. */
export type ImportItem = {
  path: string;
  title: string;
  /** Null when the page doesn't exist yet (dry run). */
  pageId: string | null;
  action: "create" | "skip";
  /** The existing page's status (skipped pages only). */
  status?: PageStatus;
};

/** A dry run: what `runImport` would do, without writing anything. */
export async function planImport(
  d: ServiceDeps,
  targets: ImportTarget[]
): Promise<ImportItem[]> {
  const plan: ImportItem[] = [];
  for (const target of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of pages, read one after another.
    const page = await getPage(d, { slug: target.slug });
    plan.push({
      path: slugToPath(target.slug),
      title: target.title,
      pageId: page?.id ?? null,
      action: page ? "skip" : "create",
      ...(page && { status: page.status }),
    });
  }
  return plan;
}

/** Creates each missing page as a draft; skips the rest. Throws on the first failure. */
export async function runImport(
  d: ServiceDeps,
  targets: ImportTarget[]
): Promise<ImportItem[]> {
  const results: ImportItem[] = [];
  for (const target of targets) {
    const path = slugToPath(target.slug);
    // biome-ignore lint/performance/noAwaitInLoops: one page at a time, so a failure stops the run where it happened.
    const existing = await getPage(d, { slug: target.slug });
    if (existing) {
      results.push({
        path,
        title: target.title,
        pageId: existing.id,
        action: "skip",
        status: existing.status,
      });
      continue;
    }
    const page = await createPage(d, {
      kind: target.kind,
      slug: target.slug,
      title: target.title,
      doc: target.doc(),
    });
    results.push({
      path,
      title: target.title,
      pageId: page.id,
      action: "create",
    });
  }
  return results;
}
