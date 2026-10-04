import type { faq } from "@repo/cms-core/blocks/faq";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import { RichText } from "../richtext/render";
import {
  type BlockComponentProps,
  Eyebrow,
  headingPrimary,
  headingWhite,
  textColor,
} from "./ui";

type Props = z.output<typeof faq.schema>;

/** Every question on its own card with the answer shown under it. */
export function FaqBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  return (
    <Reveal>
      {!!props.eyebrow && (
        <Eyebrow field={f("eyebrow")} size="xs">
          {props.eyebrow}
        </Eyebrow>
      )}
      <h2
        {...f("heading")}
        className={`font-heading font-bold text-2xl md:text-3xl ${headingWhite} mb-8`}
      >
        {props.heading}
      </h2>
      <div className="flex flex-col cms-gap">
        {props.items.map((item) => (
          <div
            key={item._key}
            {...f("items")}
            className="cms-card bg-ink-soft/50 backdrop-blur-sm p-6"
          >
            <h3
              className={`font-heading font-bold text-base ${headingPrimary} mb-3`}
            >
              {item.q}
            </h3>
            <RichText
              doc={item.a}
              path={["items", item._key, "a"]}
              className={`${textColor} font-sans text-sm leading-relaxed`}
            />
          </div>
        ))}
      </div>
    </Reveal>
  );
}
