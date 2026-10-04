import type { SiteConfig } from "@repo/cms-core/site/config";
import { defaultSeo } from "@repo/cms-core/site/seo-defaults";
import type { PublicSite, PublicSiteSeo } from "@repo/cms-core/site/types";
import { createContext, useContext } from "react";

/**
 * The published site doc, from the root loader (`__root.tsx`, public `getRootSite`). `null`
 * (nothing published, KV down) and no provider at all both mean the defaults. In the public entry
 * chunk: no Zod, and no nav/footer defaults (Navigation and Footer read it through use-site.tsx).
 */
export const SiteContext = createContext<PublicSite | null>(null);

/**
 * The deployment's SiteConfig ({ name, origin, gscProperty }), from the root loader. Browser code
 * reads it here instead of a hardcoded origin or name: the nav/footer defaults, the share card
 * wordmark, the SEO previews, and the editor/admin builders that take a config.
 */
const SiteConfigContext = createContext<SiteConfig | null>(null);

/** Provides the SiteConfig; `__root.tsx` mounts it with the root loader's `config`. */
export const SiteConfigProvider = SiteConfigContext.Provider;

/** The SiteConfig from `SiteConfigProvider`. Throws without one: there is no safe default origin. */
export function useSiteConfig(): SiteConfig {
  const config = useContext(SiteConfigContext);
  if (!config) {
    throw new Error(
      "useSiteConfig: no SiteConfigProvider (the root route provides it)"
    );
  }
  return config;
}

type HeadMatches = readonly { routeId: string; loaderData?: unknown }[];

type RootLoaderData = { site?: PublicSite | null; config?: SiteConfig };

const rootData = (matches: HeadMatches): RootLoaderData | undefined =>
  matches.find((m) => m.routeId === "__root__")?.loaderData as
    | RootLoaderData
    | undefined;

/** The SiteConfig for a route `head`, read from the root match's loader data. */
export function siteConfigFromMatches(matches: HeadMatches): SiteConfig {
  const config = rootData(matches)?.config;
  if (!config) {
    throw new Error("siteConfigFromMatches: no root loader data");
  }
  return config;
}

/** The site's SEO defaults for a route `head`, read from the root match's loader data. */
export function siteSeoFromMatches(matches: HeadMatches): PublicSiteSeo {
  return (
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the root loader data is untyped here; no site doc means the defaults.
    rootData(matches)?.site?.seo ?? defaultSeo(siteConfigFromMatches(matches))
  );
}
