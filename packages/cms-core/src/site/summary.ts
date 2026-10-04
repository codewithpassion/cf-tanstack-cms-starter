// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one flat list of checks, ported verbatim from the source (kept diffable).
import { deepEqual } from "../ops/json";
import type { NavItem, SiteDoc, SiteLink } from "./types";

/**
 * What changed between two site docs, as short phrases ("Nav: added “Pricing”", "SEO: title
 * template"). Matched by `_key`, like the page summaries (ops/summary.ts); no model call. Used for
 * revision summaries and the publish dialog.
 */
export function siteChanges(before: SiteDoc, after: SiteDoc): string[] {
  const out: string[] = [];
  out.push(...linkChanges("Nav", before.nav.links, after.nav.links));
  for (const item of after.nav.links) {
    const old = before.nav.links.find((l) => l._key === item._key);
    // A new item's dropdown links are listed too (as added), so the publish dialog names them.
    out.push(
      ...linkChanges(
        `Nav “${item.label}” dropdown`,
        old?.children ?? [],
        item.children ?? []
      )
    );
  }
  if (!same(before.nav.cta, after.nav.cta)) {
    out.push("Nav: button");
  }

  const f0 = before.footer;
  const f1 = after.footer;
  const cols = keyed(f0.columns, f1.columns);
  for (const c of cols.added) {
    out.push(`Footer: added column “${c.title}”`);
  }
  for (const c of cols.removed) {
    out.push(`Footer: removed column “${c.title}”`);
  }
  for (const [a, b] of cols.both) {
    if (a.title !== b.title) {
      out.push(`Footer: renamed column “${a.title}” → “${b.title}”`);
    }
    out.push(...linkChanges(`Footer “${b.title}”`, a.links, b.links));
  }
  if (cols.reordered) {
    out.push("Footer: reordered columns");
  }
  if (f0.tagline !== f1.tagline) {
    out.push("Footer: tagline");
  }
  if (f0.location !== f1.location) {
    out.push("Footer: location");
  }
  if (!same(f0.highlights, f1.highlights)) {
    out.push(`Footer: “${f1.highlights.title}” text`);
  }
  if (f0.copyright !== f1.copyright) {
    out.push("Footer: copyright");
  }
  out.push(...linkChanges("Footer legal links", f0.legalLinks, f1.legalLinks));

  const s0 = before.seo;
  const s1 = after.seo;
  if (s0.titleTemplate !== s1.titleTemplate) {
    out.push(`SEO: title template → “${s1.titleTemplate}”`);
  }
  if (!same(s0.defaultShareImage, s1.defaultShareImage)) {
    out.push("SEO: default share image");
  }
  if (!same(s0.organization, s1.organization)) {
    out.push("SEO: organization");
  }
  if (s0.twitterCard !== s1.twitterCard) {
    out.push(`SEO: twitter:card → ${s1.twitterCard}`);
  }

  const sw = keyed(before.swatches, after.swatches);
  if (sw.added.length) {
    out.push(`Swatches: added ${sw.added.length}`);
  }
  if (sw.removed.length) {
    out.push(`Swatches: removed ${sw.removed.length}`);
  }
  if (sw.both.some(([a, b]) => !same(a, b))) {
    out.push("Swatches: edited");
  }
  if (sw.reordered) {
    out.push("Swatches: reordered");
  }
  return out;
}

/** One line for a revision row; "No changes" when there are none. */
export function summarizeSiteChange(before: SiteDoc, after: SiteDoc): string {
  const changes = siteChanges(before, after);
  return changes.length ? changes.join(" · ") : "No changes";
}

function linkChanges(
  where: string,
  before: (SiteLink | NavItem)[],
  after: (SiteLink | NavItem)[]
): string[] {
  const out: string[] = [];
  const k = keyed(before, after);
  for (const l of k.added) {
    out.push(`${where}: added “${l.label}”`);
  }
  for (const l of k.removed) {
    out.push(`${where}: removed “${l.label}”`);
  }
  for (const [a, b] of k.both) {
    if (a.label !== b.label) {
      out.push(`${where}: renamed “${a.label}” → “${b.label}”`);
    }
    if (a.href !== b.href) {
      out.push(`${where}: “${b.label}” link → ${b.href}`);
    }
  }
  if (k.reordered) {
    out.push(`${where}: reordered`);
  }
  return out;
}

function keyed<T extends { _key: string }>(before: T[], after: T[]) {
  const added = after.filter((a) => !before.some((b) => b._key === a._key));
  const removed = before.filter((b) => !after.some((a) => a._key === b._key));
  const both = after.flatMap((a) => {
    const b = before.find((x) => x._key === a._key);
    return b ? [[b, a] as [T, T]] : [];
  });
  const order0 = before
    .filter((b) => after.some((a) => a._key === b._key))
    .map((b) => b._key);
  const order1 = both.map(([, a]) => a._key);
  return { added, removed, both, reordered: order0.join() !== order1.join() };
}

const same = deepEqual;
