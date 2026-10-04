import type { hero } from "@repo/cms-core/blocks/hero";
import { mediaUrl } from "@repo/cms-core/media";
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import type { z } from "zod";

import { useEditMode } from "../render/edit-mode";
import { type FieldProps, useField } from "../render/field";
import { Reveal } from "../render/reveal";
import {
  Accented,
  accentedField,
  type BlockComponentProps,
  Buttons,
  bigButtonClass,
  Divider,
  Eyebrow,
  headingPrimary,
  headingWhite,
  hideOnly,
  textColor,
} from "./ui";

type Props = z.output<typeof hero.schema>;

export function HeroBlock({ props }: BlockComponentProps<Props>) {
  if (props.variant === "home") {
    return <HomeHero props={props} />;
  }
  return <PageHero props={props} />;
}

function PageHero({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const page = props.variant === "page";
  return (
    // min-h matches today's `min-h-[60vh]` section minus the default pt-32 pb-20.
    <Reveal
      y={-30}
      className={
        page
          ? "min-h-[calc(60vh-13rem)] flex flex-col justify-center"
          : undefined
      }
    >
      {!!props.eyebrow && (
        <Eyebrow field={f("eyebrow")}>{props.eyebrow}</Eyebrow>
      )}
      <h1
        {...accentedField(f("heading"), props.heading, props.headingAccent)}
        className={`font-heading font-black ${page ? "text-4xl md:text-6xl" : "text-3xl md:text-5xl"} ${headingPrimary} mb-6`}
      >
        <Accented
          text={props.heading}
          accent={props.headingAccent}
          field={f("headingAccent")}
          color="text-accent"
        />
      </h1>
      <Divider />
      {!!props.lead && (
        <p
          {...f("lead")}
          className={`cms-measure max-w-3xl ${textColor} font-sans text-lg leading-relaxed`}
        >
          {props.lead}
        </p>
      )}
      <Buttons
        primary={props.primary}
        secondary={props.secondary}
        field={f("buttons")}
        className="mt-10"
      />
    </Reveal>
  );
}

/** Slides in on load (not on scroll). Static in the editor. */
function Enter({
  children,
  className,
  x = 0,
  y = 0,
  duration = 0.8,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  x?: number;
  y?: number;
  duration?: number;
  delay?: number;
}) {
  const { editing } = useEditMode();
  if (editing) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div
      className={className}
      initial={{ x, y, opacity: 0 }}
      animate={{ x: 0, y: 0, opacity: 1 }}
      transition={{ duration, delay }}
    >
      {children}
    </motion.div>
  );
}

function Logo({
  src,
  alt,
  field,
  box,
}: {
  src: string;
  alt: string;
  field: FieldProps;
  box: string;
}) {
  return (
    <div className={`relative ${box} flex items-center justify-center`}>
      {/* biome-ignore lint/correctness/useImageSize: a media-library logo of unknown size, scaled to fit its box. */}
      <img
        {...field}
        src={src}
        alt={alt}
        className="w-full h-full object-contain"
      />
    </div>
  );
}

/**
 * The `home` variant: a full-viewport band (the wrapper owns its 120px
 * top padding) with the logo beside the text on desktop and above it on mobile.
 */
function HomeHero({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const { logo } = props;
  const buttons = (
    [
      [props.primary, "primary"],
      [props.secondary, "secondary"],
      [props.tertiary, "tertiary"],
    ] as const
  ).flatMap(([b, kind]) => (b ? [{ ...b, kind }] : []));
  return (
    <div className="min-h-[calc(100vh-120px)] flex items-center justify-center">
      <div className="relative z-10">
        <div className="flex flex-col lg:flex-row-reverse items-center justify-between gap-12">
          {/* The logo's columns carry its hide markers: hidden, it leaves no empty column or gap. */}
          {!!logo && (
            <div
              {...hideOnly(f("logo"))}
              className="lg:hidden w-full flex justify-center"
            >
              <Enter className="relative" y={-50}>
                <Logo
                  src={mediaUrl(logo.mediaId)}
                  alt={logo.alt}
                  field={f("logo")}
                  box="w-64 h-64 p-6"
                />
              </Enter>
            </div>
          )}
          <Enter className="lg:w-1/2 space-y-12" x={100}>
            <div className="space-y-6">
              <h1
                {...accentedField(
                  f("heading"),
                  props.heading,
                  props.headingAccent
                )}
                className={`font-heading font-black text-4xl md:text-5xl lg:text-6xl ${headingWhite} leading-tight`}
              >
                <Accented
                  text={props.heading}
                  accent={props.headingAccent}
                  field={f("headingAccent")}
                  color="text-accent"
                />
              </h1>
              {!!props.lead && (
                <div
                  {...f("lead")}
                  className={`cms-measure ${textColor} font-sans text-xl md:text-2xl max-w-xl leading-relaxed`}
                >
                  {props.lead}
                </div>
              )}
              {!!props.eyebrow && (
                <div
                  {...f("eyebrow")}
                  className="text-[color:var(--cms-accent,var(--color-accent))] font-sans text-sm tracking-widest uppercase"
                >
                  <span className="text-primary">[</span>
                  {props.eyebrow}
                  <span className="text-primary">]</span>
                </div>
              )}
            </div>
            {buttons.length > 0 && (
              <div {...f("buttons")}>
                {/* items-start: the borderless primary stays 4px shorter than the outlined ones, as today. */}
                <div className="inline-flex flex-wrap items-start gap-6">
                  {buttons.map((b) => (
                    <a
                      key={b.kind}
                      href={b.href}
                      className={bigButtonClass(b.kind)}
                    >
                      {b.label}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </Enter>
          {!!logo && (
            <div
              {...hideOnly(f("logo"))}
              className="hidden lg:flex lg:w-1/2 justify-center md:-mt-30"
            >
              <Enter className="relative" x={-100} duration={1} delay={0.3}>
                <Logo
                  src={mediaUrl(logo.mediaId)}
                  alt={logo.alt}
                  field={f("logo")}
                  box="w-80 h-80 md:w-120 md:h-120 p-8"
                />
              </Enter>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
