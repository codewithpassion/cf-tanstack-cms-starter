import { z } from "zod";

/** Media ids are content-addressed: `<sha256>.<ext>`. The id lands inside CSS `url()` and `src`, so keep it tight. */
export const mediaIdSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/,
    "Expected a media id like <sha256>.<ext>"
  );
