import type { logos } from "@repo/cms-core/blocks/logos";
import { mediaUrl } from "@repo/cms-core/media";
import { motion } from "framer-motion";
import { BadgeCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { z } from "zod";

import { useEditMode } from "../render/edit-mode";
import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import { ICONS } from "./icons";
import {
  Accented,
  accentedField,
  type BlockComponentProps,
  bigButtonClass,
  Eyebrow,
  headingWhite,
  hideOnly,
  Lines,
  notInline,
} from "./ui";

type Props = z.output<typeof logos.schema>;

/** Scales in on scroll. Static in the editor. `attrs`: data attributes for the box. */
function ScaleIn({
  children,
  className,
  attrs,
}: {
  children: ReactNode;
  className?: string;
  attrs?: Record<string, string>;
}) {
  const { editing } = useEditMode();
  if (editing) {
    return (
      <div {...attrs} className={className}>
        {children}
      </div>
    );
  }
  return (
    <motion.div
      {...attrs}
      className={className}
      initial={{ scale: 0.95, opacity: 0 }}
      whileInView={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      viewport={{ once: true }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Proof points under a bold claim (a trust section). Its items
 * are text badges (icon, name, caption); an item with an image shows that logo instead.
 */
export function LogosBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  return (
    <>
      <Reveal y={-50} className="mb-20">
        {!!props.eyebrow && (
          <Eyebrow field={f("eyebrow")} spacing="mb-6">
            {props.eyebrow}
          </Eyebrow>
        )}
        <h2
          {...accentedField(f("heading"), props.heading, props.headingAccent)}
          className={`font-heading font-black text-4xl md:text-6xl ${headingWhite} mb-8 leading-tight`}
        >
          <Accented
            text={props.heading}
            accent={props.headingAccent}
            field={f("headingAccent")}
            color="text-primary"
          />
        </h2>
        {!!props.subheading && (
          <p
            {...accentedField(
              f("subheading"),
              props.subheading,
              props.subheadingAccent
            )}
            className="text-white font-sans text-xl md:text-2xl font-medium mb-12"
          >
            <Accented
              text={props.subheading}
              accent={props.subheadingAccent}
              field={f("subheadingAccent")}
              color="text-accent"
            />
          </p>
        )}
        {/* The box carries the callout's hide markers, so a hidden callout leaves no empty box. */}
        {!!props.callout && (
          <ScaleIn
            attrs={hideOnly(f("callout"))}
            className="cms-measure bg-primary/10 p-8 max-w-4xl backdrop-blur-sm rounded-lg"
          >
            <p
              {...f("callout")}
              className="text-lg md:text-xl text-white font-sans font-semibold leading-relaxed"
            >
              <span className="text-primary-soft">{props.callout.lead}</span>
              {!!props.callout.body && (
                <>
                  <br />
                  <br />
                  <span className="text-white/80">{props.callout.body}</span>
                </>
              )}
            </p>
          </ScaleIn>
        )}
      </Reveal>

      {props.items.length > 0 && (
        <div className="grid md:grid-cols-3 cms-gap mb-20">
          {props.items.map((item, i) => {
            const Icon = item.icon ? ICONS[item.icon] : BadgeCheck;
            return (
              <Reveal key={item._key} y={50} delay={i * 0.1} className="h-full">
                <div
                  {...f("items")}
                  className="cms-card text-left bg-ink/50 p-10 backdrop-blur-sm hover:scale-[1.02] transition-all rounded-lg h-full"
                >
                  {item.image ? (
                    // biome-ignore lint/correctness/useImageSize: a media-library logo of unknown aspect ratio, 48px high.
                    <img
                      src={mediaUrl(item.image)}
                      alt={item.name}
                      loading="lazy"
                      className="h-12 w-auto mb-6"
                    />
                  ) : (
                    <div className="text-[color:var(--cms-accent,var(--color-accent))] mb-6">
                      <Icon className="w-12 h-12" aria-hidden="true" />
                    </div>
                  )}
                  <h3 className="font-heading font-bold text-xl text-white mb-5">
                    {item.name}
                  </h3>
                  {!!item.caption && (
                    <p className="text-white/70 font-sans leading-relaxed text-base">
                      {item.caption}
                    </p>
                  )}
                </div>
              </Reveal>
            );
          })}
        </div>
      )}

      {!!(props.quote || props.button) && (
        <Reveal y={50} delay={0.3}>
          {!!props.quote && (
            <blockquote
              {...accentedField(f("quote"), props.quote, props.quoteAccent)}
              className="cms-measure text-xl md:text-2xl text-white/90 font-sans italic leading-relaxed max-w-4xl mb-12 p-10 bg-gradient-to-r from-accent/10 to-primary/10 backdrop-blur-sm rounded-lg"
            >
              <QuoteText text={props.quote} accent={props.quoteAccent} f={f} />
            </blockquote>
          )}
          {!!props.button && (
            <div {...f("button")}>
              <a href={props.button.href} className={bigButtonClass("primary")}>
                {props.button.shortLabel ? (
                  <>
                    <span className="hidden sm:inline">
                      {props.button.label}
                    </span>
                    <span className="sm:hidden">{props.button.shortLabel}</span>
                  </>
                ) : (
                  props.button.label
                )}
              </a>
            </div>
          )}
        </Reveal>
      )}
    </>
  );
}

/** The quote with its accent and line breaks (the accent may not span a line break). */
function QuoteText({
  text,
  accent,
  f,
}: {
  text: string;
  accent?: string;
  f: ReturnType<typeof useField>;
}) {
  const at = accent ? text.indexOf(accent) : -1;
  if (!accent || at < 0) {
    return <Lines text={text} />;
  }
  return (
    <>
      <Lines text={text.slice(0, at)} />
      <span {...notInline(f("quoteAccent"))} className="text-primary">
        {accent}
      </span>
      <Lines text={text.slice(at + accent.length)} />
    </>
  );
}
