import type { stats } from "@repo/cms-core/blocks/stats";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import {
  type BlockComponentProps,
  Eyebrow,
  headingPrimary,
  headingWhite,
} from "./ui";

type Props = z.output<typeof stats.schema>;

const COLUMNS: Record<number, string> = {
  1: "",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

/** A row of key numbers with labels. */
export function StatsBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const cols = COLUMNS[props.items.length] ?? "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <>
      {!!(props.eyebrow || props.heading) && (
        <Reveal className="mb-12">
          {!!props.eyebrow && (
            <Eyebrow field={f("eyebrow")}>{props.eyebrow}</Eyebrow>
          )}
          {!!props.heading && (
            <h2
              {...f("heading")}
              className={`font-heading font-bold text-2xl md:text-3xl ${headingWhite}`}
            >
              {props.heading}
            </h2>
          )}
        </Reveal>
      )}
      <div className={`grid grid-cols-1 ${cols} cms-gap`}>
        {props.items.map((item, i) => (
          <Reveal key={item._key} y={20} delay={i * 0.08}>
            <div {...f("items")}>
              <div
                className={`font-heading font-black text-4xl md:text-5xl ${headingPrimary} mb-2`}
              >
                {item.value}
              </div>
              <div className="text-white/70 font-sans text-base leading-relaxed">
                {item.label}
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </>
  );
}
