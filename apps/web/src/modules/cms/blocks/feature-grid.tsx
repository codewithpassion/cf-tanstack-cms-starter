import type { featureGrid } from "@repo/cms-core/blocks/feature-grid";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import { RichText } from "../richtext/render";
import { ICONS } from "./icons";
import {
  Accented,
  accentColor,
  accentedField,
  type BlockComponentProps,
  Eyebrow,
  headingColor,
  textColor,
} from "./ui";

type Props = z.output<typeof featureGrid.schema>;
type Item = Props["items"][number];

const COLUMNS = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-2 lg:grid-cols-3",
  4: "md:grid-cols-2 lg:grid-cols-4",
} as const;

export function FeatureGridBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const services = props.variant === "services";
  const checklist = props.variant === "checklist";
  let stagger = 0.08;
  if (services) {
    stagger = 0.1;
  } else if (checklist) {
    stagger = 0.06;
  }
  const heading = (
    <Accented
      text={props.heading}
      accent={props.headingAccent}
      field={f("headingAccent")}
      color="text-primary"
    />
  );
  return (
    <>
      <Reveal
        y={services ? -30 : 30}
        className={services ? "mb-20" : undefined}
      >
        {!!props.eyebrow && (
          <Eyebrow
            field={f("eyebrow")}
            size={checklist ? "xs" : "sm"}
            spacing={services ? "mb-6" : "mb-4"}
          >
            {props.eyebrow}
          </Eyebrow>
        )}
        {services ? (
          <h2
            {...accentedField(f("heading"), props.heading, props.headingAccent)}
            className={`font-heading font-semibold tracking-tight text-4xl md:text-5xl ${headingColor} leading-tight`}
          >
            {heading}
          </h2>
        ) : (
          <h2
            {...accentedField(f("heading"), props.heading, props.headingAccent)}
            className={`font-heading font-semibold tracking-tight text-2xl md:text-3xl ${headingColor} mb-8`}
          >
            {heading}
          </h2>
        )}
        {!!props.intro && (
          <p
            {...f("intro")}
            className={`cms-measure max-w-3xl ${textColor} font-sans text-base leading-relaxed mb-10`}
          >
            {props.intro}
          </p>
        )}
      </Reveal>
      <div className={`grid grid-cols-1 ${COLUMNS[props.columns]} cms-gap`}>
        {props.items.map((item, i) => (
          <Reveal
            key={item._key}
            y={services ? 30 : 20}
            delay={i * stagger}
            className="h-full"
          >
            <GridItem
              item={item}
              f={f}
              cards={props.variant === "cards"}
              services={services}
              checklist={checklist}
            />
          </Reveal>
        ))}
      </div>
    </>
  );
}

type F = ReturnType<typeof useField>;

function GridItem({
  item,
  f,
  cards,
  services,
  checklist,
}: {
  item: Item;
  f: F;
  cards: boolean;
  services: boolean;
  checklist: boolean;
}) {
  if (services) {
    return <ServiceCard item={item} f={f} />;
  }
  if (checklist) {
    return <CheckItem item={item} f={f} />;
  }
  return <Card item={item} cards={cards} f={f} />;
}

function Card({ item, cards, f }: { item: Item; cards: boolean; f: F }) {
  const Icon = item.icon ? ICONS[item.icon] : null;
  return (
    <div
      {...f("items")}
      className={cards ? "cms-card bg-card p-6 h-full" : "h-full"}
    >
      {!!Icon && (
        <Icon className={`w-8 h-8 ${accentColor} mb-4`} aria-hidden="true" />
      )}
      <h3
        className={`font-heading font-semibold tracking-tight text-lg ${headingColor} mb-2`}
      >
        {item.title}
      </h3>
      {!!item.body && (
        <RichText
          doc={item.body}
          path={["items", item._key, "body"]}
          className={`${textColor} font-sans text-sm leading-relaxed`}
        />
      )}
    </div>
  );
}

/**
 * Service link cards (the `services` variant). With a link, the label is
 * the link and stretches over the whole card (`after:inset-0`), so the card is clickable without
 * being an `<a>` itself: the body's rich text may hold links of its own (nested links are invalid
 * HTML), which sit above the stretched area and stay clickable.
 */
function ServiceCard({ item, f }: { item: Item; f: F }) {
  const Icon = item.icon ? ICONS[item.icon] : null;
  return (
    <div
      {...f("items")}
      className="cms-card relative text-left bg-card p-8 hover:shadow-lift hover:-translate-y-0.5 transition-all group block rounded-lg h-full"
    >
      {!!Icon && (
        <Icon
          className={`${accentColor} w-14 h-14 mb-6 group-hover:text-primary transition-colors`}
          aria-hidden="true"
        />
      )}
      <h3 className="text-foreground font-heading font-semibold tracking-tight text-xl mb-4">
        {item.title}
      </h3>
      {!!item.body && (
        <RichText
          doc={item.body}
          path={["items", item._key, "body"]}
          className="relative z-10 text-muted-foreground font-sans text-base leading-relaxed mb-6"
        />
      )}
      {!!item.link && (
        <div className="text-primary font-sans text-sm group-hover:translate-x-2 transition-transform">
          <a
            href={item.link.href}
            className="after:absolute after:inset-0 after:rounded-lg"
          >
            {item.link.label}
          </a>
        </div>
      )}
    </div>
  );
}

/** A ✓ line on a card (the `checklist` variant). */
function CheckItem({ item, f }: { item: Item; f: F }) {
  return (
    <div
      {...f("items")}
      className="cms-card bg-card p-5 flex items-start gap-4 h-full"
    >
      <span
        className={`${accentColor} font-heading font-semibold tracking-tight text-xs mt-1 shrink-0`}
        aria-hidden="true"
      >
        &#x2713;
      </span>
      <div className={`min-w-0 ${textColor} font-sans text-sm leading-relaxed`}>
        {item.title}
        {!!item.body && (
          <RichText
            doc={item.body}
            path={["items", item._key, "body"]}
            className="mt-2"
          />
        )}
      </div>
    </div>
  );
}
