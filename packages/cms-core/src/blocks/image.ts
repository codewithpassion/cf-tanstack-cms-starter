import { z } from "zod";
import { MAX_MEDIA_EDGE } from "../limits";
import { mediaIdSchema } from "../media-schema";
import { defineBlock } from "./define";

const schema = z.strictObject({
  // Optional so a freshly inserted block is valid before an image is picked; renders nothing until set.
  mediaId: mediaIdSchema.optional(),
  alt: z.string().max(300),
  caption: z.string().max(300).optional(),
  // Up to the largest image the library accepts, so picking any library image fills them validly.
  width: z.number().int().min(1).max(MAX_MEDIA_EDGE).optional(),
  height: z.number().int().min(1).max(MAX_MEDIA_EDGE).optional(),
});

export const image = defineBlock({
  type: "image",
  version: 1,
  label: "Image",
  icon: "image",
  category: "media",
  schema,
  defaults: () => ({ alt: "" }),
  defaultStyle: {
    padding: { desktop: { top: 48, bottom: 48 } },
  },
  elements: {
    image: ["hide"],
    caption: ["color", "size", "align", "hide"],
  },
  ai: "A single image from the media library with optional caption. Always write descriptive alt text (what the image shows and why it's there); leave alt empty only for purely decorative images. Set width/height from the media record to avoid layout shift.",
});
