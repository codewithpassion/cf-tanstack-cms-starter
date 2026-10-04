import type { image } from "@repo/cms-core/blocks/image";
import { mediaUrl } from "@repo/cms-core/media";
import type { z } from "zod";

import { useEditMode } from "../render/edit-mode";
import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import type { BlockComponentProps } from "./ui";

export function ImageBlock({
  props,
}: BlockComponentProps<z.output<typeof image.schema>>) {
  const f = useField();
  const { editing } = useEditMode();
  if (!props.mediaId) {
    return editing ? (
      <div className="border border-dashed border-white/30 p-12 text-center text-white/60 font-sans">
        Choose an image
      </div>
    ) : null;
  }
  return (
    <Reveal>
      <figure>
        <img
          {...f("image")}
          src={mediaUrl(props.mediaId)}
          alt={props.alt}
          width={props.width}
          height={props.height}
          loading="lazy"
          decoding="async"
          className="cms-card w-full h-auto"
        />
        {!!props.caption && (
          <figcaption
            {...f("caption")}
            className="mt-3 text-white/60 font-sans text-sm"
          >
            {props.caption}
          </figcaption>
        )}
      </figure>
    </Reveal>
  );
}
