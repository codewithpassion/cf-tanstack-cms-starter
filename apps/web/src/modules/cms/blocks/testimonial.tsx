import type { testimonial } from "@repo/cms-core/blocks/testimonial";
import { mediaUrl } from "@repo/cms-core/media";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, Quote } from "lucide-react";
import {
  type FocusEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { z } from "zod";

import { useEditMode } from "../render/edit-mode";
import { useField } from "../render/field";
import { Reveal } from "../render/reveal";
import {
  Accented,
  accentedField,
  type BlockComponentProps,
  Eyebrow,
  headingColor,
  hideOnly,
} from "./ui";

type Props = z.output<typeof testimonial.schema>;
type Item = Props["items"][number];

/**
 * One testimonial, or a carousel with dots. Autoplay has
 * a pause button (WCAG 2.2.2), never starts for visitors who prefer reduced motion, and waits while
 * the carousel is off-screen or the pointer or keyboard focus is inside it.
 */
export function TestimonialBlock({ props }: BlockComponentProps<Props>) {
  const f = useField();
  const { editing } = useEditMode();
  const count = props.items.length;
  const [current, setCurrent] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const carousel = useRef<HTMLDivElement>(null);
  const index = current < count ? current : 0;
  const autoplay = count > 1 && props.autoplay > 0 && !reducedMotion;
  const playing =
    !editing && autoplay && !paused && onScreen && !hovered && !focused;

  // The element's own window: the editor renders blocks into the canvas iframe.
  useEffect(() => {
    const win = carousel.current?.ownerDocument.defaultView;
    if (!win?.matchMedia) {
      return;
    }
    const query = win.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const el = carousel.current;
    const Observer = (
      el?.ownerDocument.defaultView as (Window & typeof globalThis) | null
    )?.IntersectionObserver;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: IntersectionObserver is missing in some embedded and older browsers.
    if (!(el && Observer) || editing || !autoplay) {
      return;
    }
    const io = new Observer(([entry]) => {
      if (entry) {
        setOnScreen(entry.isIntersecting);
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [editing, autoplay]);

  useEffect(() => {
    if (!playing) {
      return;
    }
    const id = setInterval(
      () => setCurrent((i) => (i + 1) % count),
      props.autoplay * 1000
    );
    return () => clearInterval(id);
  }, [playing, count, props.autoplay]);

  const onBlur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setFocused(false);
    }
  }, []);
  const onFocus = useCallback(() => setFocused(true), []);
  const onMouseEnter = useCallback(() => setHovered(true), []);
  const onMouseLeave = useCallback(() => setHovered(false), []);
  const togglePaused = useCallback(() => setPaused((p) => !p), []);

  const item = props.items[index];
  if (!item) {
    // The schema requires at least one item; an empty list renders nothing.
    return null;
  }
  return (
    <>
      {!!(props.eyebrow || props.heading) && (
        <Reveal y={-30} className="mb-16">
          {!!props.eyebrow && (
            <Eyebrow field={f("eyebrow")} spacing="mb-6">
              {props.eyebrow}
            </Eyebrow>
          )}
          {!!props.heading && (
            <h2
              {...accentedField(
                f("heading"),
                props.heading,
                props.headingAccent
              )}
              className={`font-heading font-semibold tracking-tight text-4xl md:text-5xl ${headingColor} leading-tight`}
            >
              <Accented
                text={props.heading}
                accent={props.headingAccent}
                field={f("headingAccent")}
                color="text-primary"
              />
            </h2>
          )}
        </Reveal>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only pause the autoplay; the region role is set whenever there is a carousel. */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: as above. */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is set only together with role="region". */}
      <div
        ref={carousel}
        className="relative text-left"
        role={count > 1 ? "region" : undefined}
        aria-roledescription={count > 1 ? "carousel" : undefined}
        aria-label={count > 1 ? (props.heading ?? "Testimonials") : undefined}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <Reveal y={30} delay={0.2}>
          <div
            {...f("card")}
            className="cms-card bg-card p-12 md:p-16 rounded-lg"
          >
            <Quote
              className="text-primary/50 w-14 h-14 mb-8"
              aria-hidden="true"
            />
            <div aria-live={count > 1 && !playing ? "polite" : "off"}>
              {editing ? (
                <Slide item={item} />
              ) : (
                <AnimatePresence mode="wait">
                  <motion.div
                    key={item._key}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.5 }}
                  >
                    <Slide item={item} />
                  </motion.div>
                </AnimatePresence>
              )}
            </div>
          </div>
        </Reveal>
        {count > 1 && (
          // Interactive in the editor too, so each testimonial can be previewed. Hidden with the card.
          <div
            {...hideOnly(f("card"))}
            className="flex justify-center gap-2 mt-8"
            data-cms-interactive=""
          >
            {props.items.map((it, i) => (
              <Dot
                key={it._key}
                index={i}
                active={i === index}
                onSelect={setCurrent}
              />
            ))}
            {!!autoplay && (
              // Beside the dots without moving them off centre: no width, and -ml-2 takes back the gap.
              <span className="relative -ml-2">
                <button
                  type="button"
                  onClick={togglePaused}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={
                    paused ? "Play testimonials" : "Pause testimonials"
                  }
                  data-testid="testimonial-pause"
                >
                  {paused ? (
                    <Play className="w-3 h-3" aria-hidden="true" />
                  ) : (
                    <Pause className="w-3 h-3" aria-hidden="true" />
                  )}
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Dot({
  active,
  index,
  onSelect,
}: {
  active: boolean;
  index: number;
  onSelect: (index: number) => void;
}) {
  const select = useCallback(() => onSelect(index), [onSelect, index]);
  return (
    <button
      type="button"
      onClick={select}
      className={`transition-all ${active ? "w-8 h-2 bg-primary" : "w-2 h-2 bg-foreground/20 hover:bg-foreground/40"}`}
      aria-label={`Go to testimonial ${index + 1}`}
      aria-current={active ? "true" : undefined}
    />
  );
}

function Slide({ item }: { item: Item }) {
  return (
    <>
      <blockquote className="text-foreground font-sans text-xl md:text-2xl leading-relaxed mb-10 italic">
        "{item.quote}"
      </blockquote>
      <div className="border-t border-primary/30 pt-8 flex items-center gap-4">
        {!!item.image && (
          <img
            src={mediaUrl(item.image)}
            alt=""
            loading="lazy"
            className="w-14 h-14 rounded-full object-cover shrink-0"
            width={56}
            height={56}
          />
        )}
        <div>
          <cite className="text-primary font-heading font-semibold tracking-tight text-xl not-italic">
            {item.name}
          </cite>
          {!!item.role && (
            <div className="text-muted-foreground font-sans text-base mt-2">
              {item.company ? `${item.role} at ${item.company}` : item.role}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
