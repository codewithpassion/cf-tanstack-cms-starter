import { useSiteConfig } from "#/modules/cms/site/site-context";
import { SiteHref, useSite } from "#/modules/cms/site/use-site";
import { Logo } from "./logo";

// One grid column per footer column, plus the brand column and (when it has items) the text
// column, from lg up. Whole class names, so Tailwind generates them.
const LG_COLS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
  8: "lg:grid-cols-8",
};

const heading = "mb-4 font-sans font-semibold text-foreground text-sm";

/**
 * The public site's footer, from the site doc's footer (site/use-site.tsx). CMS pages render it
 * themselves (unless the page sets `chrome: "none"`). The text column ("highlights") is left out
 * while it has no items.
 */
export function Footer() {
  const currentYear = new Date().getFullYear();
  const { name } = useSiteConfig();
  const { footer } = useSite();
  const hasHighlights = footer.highlights.items.length > 0;
  const columns = footer.columns.length + 1 + (hasHighlights ? 1 : 0);

  return (
    <footer className="border-border border-t bg-muted/40 py-12 font-sans text-muted-foreground text-sm">
      <div className="mx-auto max-w-6xl px-6">
        <div
          className={`grid grid-cols-1 gap-8 md:grid-cols-2 ${LG_COLS[columns] ?? "lg:grid-cols-4"}`}
        >
          {/* Brand */}
          <div>
            <div className="mb-3">
              <Logo name={name} />
            </div>
            <p className="mb-2">{footer.tagline}</p>
            <p className="text-xs">{footer.location}</p>
          </div>

          {/* Link columns */}
          {footer.columns.map((column) => (
            <div key={column._key}>
              <h2 className={heading}>{column.title}</h2>
              <nav aria-label={column.title} className="flex flex-col gap-2">
                {column.links.map((link) => (
                  <SiteHref
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    href={link.href}
                    key={link._key}
                  >
                    {link.label}
                  </SiteHref>
                ))}
              </nav>
            </div>
          ))}

          {/* Text column */}
          {hasHighlights && (
            <div>
              <h2 className={heading}>{footer.highlights.title}</h2>
              <div className="flex flex-col gap-2">
                {footer.highlights.items.map((item) => (
                  <p className="text-xs" key={item._key}>
                    {item.text}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div className="mt-8 flex flex-col items-start justify-between gap-4 border-border border-t pt-8 md:flex-row md:items-center">
          <p className="text-xs">
            &copy; {currentYear}
            {` ${footer.copyright}`}
          </p>
          {/* Legal links go through SiteHref (a router Link for site paths): the CMS catch-all serves them. */}
          {footer.legalLinks.length > 0 && (
            <div className="flex gap-6">
              {footer.legalLinks.map((link) => (
                <SiteHref
                  className="text-xs transition-colors hover:text-foreground"
                  href={link.href}
                  key={link._key}
                >
                  {link.label}
                </SiteHref>
              ))}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
