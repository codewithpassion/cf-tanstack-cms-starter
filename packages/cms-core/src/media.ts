/** Zod-free, so `buildHead` (imported by route `head`s) can use it; the id schema is in media-schema.ts. */
export function mediaUrl(mediaId: string): string {
  return `/media/${mediaId}`;
}
