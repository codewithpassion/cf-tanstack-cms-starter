import type { richText } from "@repo/cms-core/blocks/rich-text";
import type { z } from "zod";

import { useField } from "../render/field";
import { useInPost } from "../render/post-context";
import { Reveal } from "../render/reveal";
import { RichText } from "../richtext/render";
import { type BlockComponentProps, textColor } from "./ui";

export function RichTextBlock({
  props,
}: BlockComponentProps<z.output<typeof richText.schema>>) {
  const f = useField();
  // In a blog post, the article typography (each element sets its own colour and size).
  const inPost = useInPost();
  return (
    <Reveal>
      <div {...f("body")}>
        {inPost ? (
          <RichText doc={props.body} path={["body"]} variant="article" />
        ) : (
          <RichText
            doc={props.body}
            path={["body"]}
            className={`${textColor} font-sans text-lg`}
          />
        )}
      </div>
    </Reveal>
  );
}
