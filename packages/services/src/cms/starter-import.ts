import { slugToPath } from "@repo/cms-core/paths";
import { validateSiteDoc } from "@repo/cms-core/site/schema";
import {
  STARTER_IMAGE_KEYS,
  type StarterMedia,
  starterPages,
  starterSiteDoc,
} from "@repo/cms-core/starter-content";
import { type MediaDeps, uploadMedia } from "./media-service";
import {
  CmsError,
  createPage,
  getPage,
  publish,
  type ServiceDeps,
} from "./pages-service";
import {
  getSiteState,
  publishSite,
  type SiteDeps,
  saveSiteDraft,
} from "./site-service";
import { STARTER_IMAGE_ALT, starterImagePng } from "./starter-images";

/**
 * Writes the starter content (cms-core `starter-content.ts`) through the page, site and media
 * services, and publishes it. Used by /admin/setup and `bun run seed`.
 *
 * Idempotent: a page that already exists at a slug is skipped (never overwritten, never
 * re-published), and the site settings are written only while they have never been edited
 * (no draft row yet), so a second run, or a run after editing, changes nothing. Images are
 * content-addressed, so uploading them again is a no-op; they are only uploaded when some page
 * is missing.
 */

export type StarterImportDeps = {
  pages: ServiceDeps;
  site: SiteDeps;
  media: MediaDeps;
};

export type StarterImportItem = {
  path: string;
  title: string;
  pageId: string;
  action: "create" | "skip";
};

export type StarterImportResult = {
  items: StarterImportItem[];
  site: "created" | "skipped";
};

async function uploadStarterImages(media: MediaDeps): Promise<StarterMedia> {
  const entries = await Promise.all(
    STARTER_IMAGE_KEYS.map(async (key) => {
      const { media: info } = await uploadMedia(media, {
        bytes: await starterImagePng(key),
        alt: STARTER_IMAGE_ALT[key],
      });
      return [
        key,
        { mediaId: info.id, width: info.width ?? 0, height: info.height ?? 0 },
      ] as const;
    })
  );
  return Object.fromEntries(entries) as StarterMedia;
}

export async function importStarterContent(
  deps: StarterImportDeps
): Promise<StarterImportResult> {
  // Slugs are known without media ids, so find what is missing before uploading anything.
  const placeholder = Object.fromEntries(
    STARTER_IMAGE_KEYS.map((key) => [
      key,
      { mediaId: `${"0".repeat(64)}.png`, width: 1, height: 1 },
    ])
  ) as StarterMedia;
  const wanted = starterPages(placeholder);
  const existing = new Map<string, string>();
  for (const { slug } of wanted) {
    // biome-ignore lint/performance/noAwaitInLoops: seven lookups, one after another.
    const page = await getPage(deps.pages, { slug });
    if (page) {
      existing.set(slug, page.id);
    }
  }

  // Validate everything that will be written before writing anything, so a bad document can't
  // leave the import half-applied.
  const state = await getSiteState(deps.site);
  const writeSite = state.draftVersion === 0;
  for (const page of wanted) {
    if (existing.has(page.slug)) {
      continue;
    }
    const checked = deps.pages.validate({
      ...page.doc,
      seo: { ...page.doc.seo, slug: page.slug },
    });
    if (!checked.ok) {
      throw new CmsError(
        "INVALID_DOC",
        `starter page "${page.slug}" failed validation`,
        checked.errors
      );
    }
  }
  const siteDoc = writeSite ? starterSiteDoc(deps.site.config) : null;
  if (siteDoc) {
    const checked = validateSiteDoc(siteDoc);
    if (!checked.ok) {
      throw new CmsError(
        "INVALID_DOC",
        "starter site settings failed validation",
        checked.errors
      );
    }
  }

  const pages =
    existing.size === wanted.length
      ? wanted
      : starterPages(await uploadStarterImages(deps.media));

  const items: StarterImportItem[] = [];
  for (const page of pages) {
    const path = slugToPath(page.slug);
    const found = existing.get(page.slug);
    if (found) {
      items.push({ path, title: page.title, pageId: found, action: "skip" });
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one page at a time, so a failure stops where it happened.
    const created = await createPage(deps.pages, page);
    await publish(deps.pages, created.id, created.draftVersion);
    items.push({
      path,
      title: page.title,
      pageId: created.id,
      action: "create",
    });
  }

  if (!siteDoc) {
    return { items, site: "skipped" };
  }
  const saved = await saveSiteDraft(deps.site, 0, siteDoc);
  await publishSite(deps.site, saved.draftVersion);
  return { items, site: "created" };
}
