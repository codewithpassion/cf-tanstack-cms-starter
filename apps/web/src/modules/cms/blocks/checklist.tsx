import type { checklist } from "@repo/cms-core/blocks/checklist";
import type { z } from "zod";

import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import { RichText } from "../richtext/render";
import {
  type BlockComponentProps,
  Eyebrow,
  headingColor,
  textColor,
} from "./ui";

type Props = z.output<typeof checklist.schema>;

/**
 * Things to do or have ready beforehand: an empty box per item, then an optional highlighted note.
 * The eyebrow and heading take element colour and size like the other blocks; item and note text
 * is rich text, whose wrapper sets its own colour and size.
 */
export function ChecklistBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  return (
    <Reveal>
      {!!props.eyebrow && (
        <Eyebrow field={f("eyebrow")} size="xs">
          {props.eyebrow}
        </Eyebrow>
      )}
      {!!props.heading && (
        <h2
          {...f("heading")}
          className={`font-heading font-semibold tracking-tight text-2xl md:text-3xl ${headingColor} mb-8`}
        >
          {props.heading}
        </h2>
      )}
      <ul {...f("items")} className="space-y-4">
        {props.items.map((item) => (
          <li key={item._key} className="flex items-start gap-4">
            <span
              className="mt-1 size-4 shrink-0 rounded-sm border-2 border-[color:var(--cms-accent,var(--brand-label))]"
              aria-hidden="true"
            />
            <RichText
              doc={item.body}
              path={["items", item._key, "body"]}
              className={`min-w-0 ${textColor} font-sans text-base leading-relaxed`}
            />
          </li>
        ))}
      </ul>
      {!!props.note && (
        <div
          {...f("note")}
          className="mt-8 border-l-4 border-primary bg-primary/10 p-5"
        >
          <RichText
            doc={props.note}
            path={["note"]}
            className={`${textColor} font-sans text-sm leading-relaxed`}
          />
        </div>
      )}
    </Reveal>
  );
}
