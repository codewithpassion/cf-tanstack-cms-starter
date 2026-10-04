// biome-ignore-all lint/performance/noJsxPropsBind: ported from the source navigation; inline handlers on a handful of links.
import type { NavItem } from "@repo/cms-core/site/types";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Menu, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useSiteConfig } from "#/modules/cms/site/site-context";
import { SiteHref, useSite } from "#/modules/cms/site/use-site";
import { Logo } from "./logo";
import ThemeToggle from "./theme-toggle";

const linkBase = "font-sans text-sm transition-colors";
const linkIdle = "text-muted-foreground hover:text-foreground";
const linkActive = "text-foreground";

/**
 * The public site's top bar, from the site doc's nav (site/use-site.tsx). CMS pages render it
 * themselves (unless the page sets `chrome: "none"`). In flow and sticky, not fixed: CMS blocks
 * don't leave room for a fixed bar. Links with `children` get a dropdown on desktop (hover, or the
 * toggle button for touch and keyboard) and an indented list on mobile. `actions` go after the
 * theme toggle.
 */
export function Navigation({ actions }: { actions?: ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // The desktop dropdown opened with its toggle button (touch, keyboard); hover opens any of them.
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const location = useLocation();

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes the dropdown whenever the path changes, as in the source.
  useEffect(() => setOpenDropdown(null), [location.pathname]);
  useEffect(() => {
    if (!openDropdown) {
      return;
    }
    const close = (e: Event) => {
      const outside = !(e.target as Element).closest?.(
        `[data-dropdown="${openDropdown}"]`
      );
      if (e instanceof KeyboardEvent ? e.key === "Escape" : outside) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [openDropdown]);

  const { name } = useSiteConfig();
  const { nav } = useSite();
  const navLinks = nav.links;

  const isActive = (path: string) => location.pathname === path;
  // A dropdown parent shows as active on any of its pages.
  const isActiveItem = (link: NavItem) =>
    isActive(link.href) ||
    !!link.children?.some((child) => isActive(child.href));

  return (
    <header className="sticky top-0 z-50 border-border border-b bg-background/95 backdrop-blur-md">
      <nav aria-label="Main" className="mx-auto max-w-6xl px-6">
        <div className="flex h-16 items-center justify-between gap-4">
          <Link
            className="no-underline transition-opacity hover:opacity-80"
            to="/"
          >
            <Logo name={name} />
          </Link>

          {/* Desktop */}
          <div className="hidden items-center gap-8 md:flex">
            {navLinks.map((link) => {
              const active = isActiveItem(link);
              const item = (
                <SiteHref
                  className={`relative ${linkBase} ${active ? linkActive : linkIdle}`}
                  href={link.href}
                  key={link._key}
                >
                  {link.label}
                </SiteHref>
              );
              if (!link.children?.length) {
                return item;
              }
              // Dropdown: shown on hover, or with the toggle button beside the link (touch, keyboard).
              const open = openDropdown === link._key;
              const menuId = `nav-menu-${link._key}`;
              return (
                <div
                  className="group relative flex items-center gap-1"
                  data-dropdown={link._key}
                  key={link._key}
                >
                  {item}
                  <button
                    aria-controls={menuId}
                    aria-expanded={open}
                    aria-haspopup="true"
                    aria-label={`${link.label} menu`}
                    className={`-m-2 p-2 transition-colors ${active || open ? linkActive : linkIdle}`}
                    onClick={() => setOpenDropdown(open ? null : link._key)}
                    type="button"
                  >
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                  <div
                    className={`absolute top-full left-0 pt-3 group-hover:block ${open ? "block" : "hidden"}`}
                    id={menuId}
                  >
                    <div className="flex min-w-48 flex-col rounded-md border border-border bg-popover py-2 shadow-lift">
                      {link.children.map((child) => (
                        <SiteHref
                          className={`whitespace-nowrap px-4 py-2 ${linkBase} ${isActive(child.href) ? linkActive : linkIdle}`}
                          href={child.href}
                          key={child._key}
                        >
                          {child.label}
                        </SiteHref>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}

            <SiteHref
              className="rounded-md bg-primary px-3.5 py-2 font-medium font-sans text-primary-foreground text-sm shadow-soft transition-colors hover:bg-primary/90"
              href={nav.cta.href}
            >
              {nav.cta.label}
            </SiteHref>
            <div className="flex items-center gap-1.5">
              <ThemeToggle />
              {actions}
            </div>
          </div>

          {/* Mobile: theme toggle, actions and the menu button */}
          <div className="flex items-center gap-1.5 md:hidden">
            <ThemeToggle />
            {actions}
            <button
              aria-expanded={mobileMenuOpen}
              aria-label="Toggle menu"
              className="text-foreground"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              type="button"
            >
              {mobileMenuOpen ? (
                <X className="h-6 w-6" />
              ) : (
                <Menu className="h-6 w-6" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {!!mobileMenuOpen && (
          <div className="max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-border border-t py-4 md:hidden">
            <div className="flex flex-col gap-2">
              {navLinks.map((link) => (
                <Fragment key={link._key}>
                  <SiteHref
                    className={`py-2 ${linkBase} ${isActiveItem(link) ? `${linkActive} font-semibold` : linkIdle}`}
                    href={link.href}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {link.label}
                  </SiteHref>
                  {link.children?.map((child) => (
                    <SiteHref
                      className={`py-2 pl-4 ${linkBase} ${isActive(child.href) ? `${linkActive} font-semibold` : linkIdle}`}
                      href={child.href}
                      key={child._key}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      {child.label}
                    </SiteHref>
                  ))}
                </Fragment>
              ))}

              <SiteHref
                className="mt-2 rounded-md bg-primary px-3.5 py-3 text-center font-medium font-sans text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                href={nav.cta.href}
                onClick={() => setMobileMenuOpen(false)}
              >
                {nav.cta.label}
              </SiteHref>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}
