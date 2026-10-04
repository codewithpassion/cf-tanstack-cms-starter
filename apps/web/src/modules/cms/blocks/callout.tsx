import type { callout } from "@repo/cms-core/blocks/callout";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import { RichText } from "../richtext/render";
import {
  type BlockComponentProps,
  Eyebrow,
  headingWhite,
  textColor,
} from "./ui";

type Props = z.output<typeof callout.schema>;

/** Rich text in a highlighted box. */
export function CalloutBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  return (
    <Reveal className="cms-card bg-ink-soft/50 backdrop-blur-sm p-8 md:p-12">
      {!!props.eyebrow && (
        <Eyebrow field={f("eyebrow")} size="xs">
          {props.eyebrow}
        </Eyebrow>
      )}
      {!!props.heading && (
        <h2
          {...f("heading")}
          className={`font-heading font-bold text-2xl md:text-3xl ${headingWhite} mb-6`}
        >
          {props.heading}
        </h2>
      )}
      <div {...f("body")}>
        <RichText
          doc={props.body}
          path={["body"]}
          className={`cms-measure max-w-3xl ${textColor} font-sans text-base leading-relaxed`}
        />
      </div>
    </Reveal>
  );
}
