import type { MediaInfo } from "@repo/services/cms/media-service";

/**
 * Appends a "Load more" page, skipping ids already listed: an upload that matched an older item
 * moves it to the front, and a later page can return it again.
 */
export function appendPage(prev: MediaInfo[], page: MediaInfo[]): MediaInfo[] {
  const seen = new Set(prev.map((m) => m.id));
  const added: MediaInfo[] = [];
  for (const m of page) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      added.push(m);
    }
  }
  return [...prev, ...added];
}
