import type { steps } from "@repo/cms-core/blocks/steps";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import { RichText } from "../richtext/render";
import {
  accentColor,
  type BlockComponentProps,
  Eyebrow,
  headingPrimary,
  headingWhite,
  textColor,
} from "./ui";

type Props = z.output<typeof steps.schema>;

/** Phases or steps as stacked cards. No HowTo JSON-LD. */
export function StepsBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  return (
    <>
      <Reveal y={0}>
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
        {!!props.intro && (
          <p
            {...f("intro")}
            className={`cms-measure max-w-3xl ${textColor} font-sans text-base leading-relaxed mb-8`}
          >
            {props.intro}
          </p>
        )}
      </Reveal>
      <div className="flex flex-col cms-gap">
        {props.items.map((item, i) => (
          <Reveal key={item._key} y={20} delay={i * 0.08}>
            <div
              {...f("items")}
              className="cms-card bg-ink-soft/50 backdrop-blur-sm p-6 md:p-8"
            >
              <div className="flex items-baseline gap-4 mb-4">
                {!!item.label && (
                  <span
                    className={`${accentColor} font-heading font-bold text-sm`}
                  >
                    {item.label}
                  </span>
                )}
                <h3
                  className={`font-heading font-bold text-lg ${headingPrimary}`}
                >
                  {item.title}
                </h3>
              </div>
              <RichText
                doc={item.body}
                path={["items", item._key, "body"]}
                bullets="check"
                className={`ml-8 ${textColor} font-sans text-sm leading-relaxed`}
              />
            </div>
          </Reveal>
        ))}
      </div>
    </>
  );
}
