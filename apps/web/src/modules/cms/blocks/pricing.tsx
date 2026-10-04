import type { pricing } from "@repo/cms-core/blocks/pricing";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import {
  accentColor,
  type BlockComponentProps,
  Buttons,
  Eyebrow,
  headingColor,
} from "./ui";

type Props = z.output<typeof pricing.schema>;
type Plan = Props["plans"][number];

const card = "cms-card bg-card";

/** Grid columns by plan count; four or more wrap at two, then four. */
const PLAN_COLUMNS: Partial<Record<number, string>> = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
};

/**
 * Prices as displayed text (no Offer JSON-LD: pages that need it use `seo.schema.extra`). One plan
 * renders as a single card holding the whole section; several
 * render as a row of plan cards under the heading.
 */
export function PricingBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const single = props.plans.length === 1;
  const header = (
    <>
      {!!props.eyebrow && (
        <Eyebrow field={f("eyebrow")} size="xs">
          {props.eyebrow}
        </Eyebrow>
      )}
      <h2
        {...f("heading")}
        className={`font-heading font-semibold tracking-tight text-2xl ${single ? "" : "md:text-3xl "}${headingColor} mb-4`}
      >
        {props.heading}
      </h2>
      {!!props.intro && (
        <p
          {...f("intro")}
          className="cms-measure text-muted-foreground font-sans text-base leading-relaxed max-w-2xl mb-6"
        >
          {props.intro}
        </p>
      )}
    </>
  );
  const note = props.note && (
    <p
      {...f("note")}
      className="cms-measure text-muted-foreground font-sans text-sm leading-relaxed max-w-2xl"
    >
      {props.note}
    </p>
  );

  const [first] = props.plans;
  if (single && first) {
    return (
      <Reveal y={20} className={`${card} p-8 md:p-12`}>
        {header}
        <PlanBody plan={first} f={f} />
        {note}
      </Reveal>
    );
  }
  const cols =
    PLAN_COLUMNS[props.plans.length] ?? "md:grid-cols-2 lg:grid-cols-4";
  return (
    <>
      <Reveal y={20}>{header}</Reveal>
      <div className={`grid grid-cols-1 ${cols} cms-gap mb-8`}>
        {props.plans.map((plan, i) => (
          <Reveal key={plan._key} y={20} delay={i * 0.08} className="h-full">
            {/* The highlight border is an unlayered rule (cms.css), so the block's border style can't override it. */}
            <div
              className={`${card} p-8 h-full`}
              data-cms-highlight={plan.highlight ? "" : undefined}
            >
              <PlanBody plan={plan} f={f} />
            </div>
          </Reveal>
        ))}
      </div>
      {note}
    </>
  );
}

function PlanBody({ plan, f }: { plan: Plan; f: ReturnType<typeof useField> }) {
  return (
    <div {...f("plans")}>
      {!!plan.name && (
        <h3
          className={`font-heading font-semibold tracking-tight text-lg ${headingColor} mb-3`}
        >
          {plan.name}
        </h3>
      )}
      <p
        {...f("price")}
        className="text-primary font-heading font-semibold tracking-tight text-3xl md:text-4xl mb-3"
      >
        {plan.price}
        {!!plan.unit && (
          <>
            {" "}
            <span className="text-muted-foreground text-xl md:text-2xl">
              {plan.unit}
            </span>
          </>
        )}
      </p>
      {plan.inclusions.length > 0 && (
        <ul className="space-y-2 mb-6">
          {plan.inclusions.map((inc) => (
            <li key={inc._key} className="flex items-start gap-3">
              <span
                className={`${accentColor} font-heading font-semibold tracking-tight text-xs mt-1 shrink-0`}
                aria-hidden="true"
              >
                &#x2713;
              </span>
              <span className="text-muted-foreground font-sans text-sm leading-relaxed">
                {inc.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!!plan.cta && (
        <Buttons primary={plan.cta} field={f("cta")} className="mb-6" />
      )}
    </div>
  );
}
