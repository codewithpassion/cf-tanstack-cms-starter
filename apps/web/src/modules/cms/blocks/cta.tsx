import type { cta } from "@repo/cms-core/blocks/cta";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import {
  Accented,
  accentedField,
  type BlockComponentProps,
  Buttons,
  bigButtonClass,
  headingWhite,
  textColor,
} from "./ui";

type Props = z.output<typeof cta.schema>;

export function CtaBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const compact = props.variant === "compact";
  return (
    <Reveal>
      {!!props.heading && (
        <h2
          {...accentedField(f("heading"), props.heading, props.headingAccent)}
          className={`font-heading font-black text-4xl md:text-5xl ${headingWhite} leading-tight mb-8`}
        >
          <Accented
            text={props.heading}
            accent={props.headingAccent}
            field={f("headingAccent")}
            color="text-accent"
          />
        </h2>
      )}
      {!!props.body &&
        (compact ? (
          <p {...f("body")} className="text-white/60 font-sans mb-6">
            {props.body}
          </p>
        ) : (
          <p
            {...f("body")}
            className={`cms-measure max-w-2xl ${textColor} font-sans text-xl md:text-2xl leading-relaxed mb-12`}
          >
            {props.body}
          </p>
        ))}
      {props.variant === "large" ? (
        <div {...f("buttons")}>
          <div className="inline-flex flex-wrap gap-4">
            <a
              href={props.primary.href}
              className={bigButtonClass("primary", "lg")}
            >
              {props.primary.label}
            </a>
            {!!props.secondary && (
              <a
                href={props.secondary.href}
                className={bigButtonClass("tertiary", "lg")}
              >
                {props.secondary.label}
              </a>
            )}
          </div>
        </div>
      ) : (
        <Buttons
          primary={props.primary}
          secondary={props.secondary}
          field={f("buttons")}
        />
      )}
      {!!props.link && (
        <div {...f("link")} className="mt-8">
          <a
            href={props.link.href}
            className="text-accent font-sans text-sm tracking-wider hover:text-white transition-colors"
          >
            {props.link.label}
          </a>
        </div>
      )}
    </Reveal>
  );
}
