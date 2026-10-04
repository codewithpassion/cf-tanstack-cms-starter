/**
 * Deployment-level site settings, from the `SITE_NAME`, `SITE_ORIGIN` and `GSC_PROPERTY` vars.
 * Builders take it as a parameter instead of importing a hardcoded origin or name.
 */
export type SiteConfig = {
  /** Shown in titles, the OG card wordmark and JSON-LD. */
  name: string;
  /** Public origin without a trailing slash, e.g. `https://example.com`. */
  origin: string;
  /** Search Console property, e.g. `sc-domain:example.com`; null when not configured. */
  gscProperty: string | null;
};
