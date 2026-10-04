/**
 * Page-wide limits, shared by the server (validate.ts, pages-service.ts) and the editor store,
 * which checks them before accepting an edit. Dependency-free so the page service doesn't pull in
 * the block registry.
 */

export const MAX_BLOCKS = 200;
/** Serialised (UTF-8) document size cap. */
export const MAX_DOC_BYTES = 1_000_000;

/** Largest accepted image width or height: uploads (server/media-bytes.ts) and the image block's width/height. */
export const MAX_MEDIA_EDGE = 16_384;
