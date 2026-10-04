/**
 * The site mark: a simple generic SVG glyph plus the site name as a wordmark. DESIGN KNOB: swap the
 * paths below for your own logo; `name` comes from the SITE_NAME var. public/favicon.svg uses the
 * same glyph.
 */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 32 32"
    >
      <rect fill="var(--primary)" height="32" rx="8" width="32" />
      <path
        d="M9 21.5 16 9l7 12.5H9Z"
        fill="var(--primary-foreground)"
        fillOpacity="0.95"
      />
    </svg>
  );
}

export function Logo({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      <span className="font-heading font-semibold text-foreground text-lg tracking-tight">
        {name}
      </span>
    </span>
  );
}
