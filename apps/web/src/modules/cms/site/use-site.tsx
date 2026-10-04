import { defaultPublicSite } from "@repo/cms-core/site/defaults";
import type { PublicSite } from "@repo/cms-core/site/types";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, useContext } from "react";

import { SiteContext, useSiteConfig } from "./site-context";

/** The published site doc (site-context.ts), or the defaults. For Navigation and Footer. */
export function useSite(): PublicSite {
  const config = useSiteConfig();
  return useContext(SiteContext) ?? defaultPublicSite(config);
}

/** A plain site path: no query, fragment, or `$`, `{`, `}` (route params to the router). */
const PLAIN_PATH_RE = /^\/[^?#${}]*$/;

/**
 * A site doc link: a router `Link` for a plain site path (client-side navigation and active state),
 * a plain anchor for anything else (external, mailto:, #, ?query, and paths with `$`, `{` or `}`,
 * which the router would read as route params).
 */
export function SiteHref({
  href,
  ...rest
}: { href: string } & Omit<ComponentProps<"a">, "href">) {
  if (PLAIN_PATH_RE.test(href)) {
    return <Link to={href} {...rest} />;
  }
  return <a href={href} {...rest} />;
}
