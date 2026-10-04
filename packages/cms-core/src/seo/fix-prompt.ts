import { nanoid } from "nanoid";
import { MAX_PLAN_ITEMS } from "../agent/plan";
import type { Inspection, QueryRow } from "../gsc/shape";
import type { SeoOverviewIssue } from "./overview-table";

/**
 * /admin/seo "Fix with agent": the issues picked on the Pages and Opportunities views, turned into
 * the first message of a site-wide agent conversation, which plans one item per page. Pure, so it is tested without the UI.
 */

/** Checks the agent can't fix: `propose_seo` never changes the slug, and has no robots/sitemap fields. */
export const AGENT_UNFIXABLE_CHECKS: ReadonlySet<string> = new Set([
  "slug",
  "indexing",
]);

/** Queries per page in the prompt: the plan's intent has room for a sentence or two, not a report. */
export const PROMPT_QUERIES_PER_PAGE = 8;

/** The agent API's message limit (handler.ts bodySchema). */
export const MAX_PROMPT_CHARS = 8000;

export type FixTarget = {
  pageId: string;
  path: string;
  title: string;
  issues: SeoOverviewIssue[];
  /** Striking-distance queries to target. */
  queries: QueryRow[];
  /** Not indexed: the latest inspection (null when never inspected). */
  notIndexed?: { inspection: Inspection | null } | null;
};

const pos = (n: number) => n.toFixed(1);

function pageSection(t: FixTarget, queriesPerPage: number): string {
  const lines = [`## ${t.path} (“${t.title}”)`];
  if (t.issues.length) {
    lines.push("Check issues:");
    for (const i of t.issues) {
      lines.push(`- [${i.status}] ${i.label}: ${i.message}`);
    }
  }
  if (t.queries.length) {
    lines.push(
      "Search queries in striking distance (avg position 4–20, last 28 days):"
    );
    for (const q of t.queries.slice(0, queriesPerPage)) {
      lines.push(
        `- “${q.query}”: ${q.impressions} impressions, ${q.clicks} clicks, position ${pos(q.position)}`
      );
    }
    if (t.queries.length > queriesPerPage) {
      lines.push(
        `- …and ${t.queries.length - queriesPerPage} more (see find_seo_opportunities)`
      );
    }
  }
  if (t.notIndexed) {
    const i = t.notIndexed.inspection;
    lines.push(
      i
        ? `Not indexed by Google: verdict ${i.verdict}${i.coverageState ? `, “${i.coverageState}”` : ""}${i.lastCrawl ? `, last crawled ${i.lastCrawl.slice(0, 10)}` : ", never crawled"}.`
        : "Not indexed by Google: never inspected yet."
    );
  }
  return lines.join("\n");
}

const INSTRUCTIONS = [
  "Make a site-wide plan with one item per page above (action “seo” for titles, descriptions and keyphrases; “edit” when the content itself has to change: headings, alt text, internal links, word count).",
  "Use the queries as the keyphrase and wording evidence. For pages that aren't indexed, improve what makes them worth indexing (unique title and description, enough useful content, internal links to them); you can't request a crawl.",
  "Keep the existing voice and facts; don't invent claims, prices or clients. Everything stays a draft for me to review.",
];

/**
 * The message: a short first line (it becomes the conversation title), the per-page findings, then
 * what to do. Queries per page shrink until it fits `MAX_PROMPT_CHARS`.
 */
export function buildFixPrompt(targets: readonly FixTarget[]): string {
  if (!targets.length) {
    throw new Error("Pick at least one issue");
  }
  if (targets.length > MAX_PLAN_ITEMS) {
    throw new Error(`A run can cover at most ${MAX_PLAN_ITEMS} pages`);
  }
  const paths = targets.map((t) => t.path);
  let head = `Fix SEO on ${targets.length} ${targets.length === 1 ? "page" : "pages"}: ${paths.join(", ")}`;
  if (head.length > 80) {
    head = `${head.slice(0, 79)}…`;
  }
  for (
    let perPage = PROMPT_QUERIES_PER_PAGE;
    ;
    perPage = Math.floor(perPage / 2)
  ) {
    const text = [
      head,
      "",
      ...targets.map((t) => pageSection(t, perPage)),
      "",
      ...INSTRUCTIONS,
    ].join("\n");
    if (text.length <= MAX_PROMPT_CHARS) {
      return text;
    }
    if (perPage === 0) {
      return `${text.slice(0, MAX_PROMPT_CHARS - 1)}…`;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The handoff to the editor: the prompt waits in sessionStorage under a one-time key in the URL.

export const FIX_PARAM = "seoFix";
const storageKey = (key: string) => `cms-seo-fix:${key}`;

export function stashFixPrompt(
  storage: Pick<Storage, "setItem">,
  prompt: string
): string {
  // nanoid, not crypto.randomUUID: randomUUID only exists in secure contexts (the dev server on a plain-HTTP IP).
  const key = nanoid();
  storage.setItem(storageKey(key), prompt);
  return key;
}

/** Reads and deletes the prompt: a reload or Back must not start a second (paid) planning turn. */
export function takeFixPrompt(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string
): string | null {
  const prompt = storage.getItem(storageKey(key));
  storage.removeItem(storageKey(key));
  return prompt;
}
