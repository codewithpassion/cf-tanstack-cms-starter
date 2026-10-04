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
  /** IANA zone for "today" (post dates, the agent's daily budget). Default "UTC" (D14). */
  timeZone: string;
};

const TRAILING_SLASHES = /\/+$/;

/**
 * The only way to build a `SiteConfig` from raw vars: trims, strips trailing slashes from the
 * origin and throws on an empty or non-http(s) origin, so every builder can rely on `origin`.
 */
export function siteConfig(input: {
  name: string;
  origin: string;
  gscProperty?: string | null;
  /** IANA zone, e.g. `Europe/Berlin`; empty or unset means UTC. Throws on an unknown zone. */
  timeZone?: string | null;
}): SiteConfig {
  const { gscProperty, name } = input;
  const timeZone = input.timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch (error) {
    throw new Error(
      `SITE_TIME_ZONE is not an IANA time zone: ${JSON.stringify(timeZone)}`,
      { cause: error }
    );
  }
  const origin = input.origin.trim().replace(TRAILING_SLASHES, "");
  if (!origin) {
    throw new Error(
      "SITE_ORIGIN is empty: set it to the public origin, e.g. https://example.com"
    );
  }
  let protocol: string;
  try {
    ({ protocol } = new URL(origin));
  } catch (error) {
    throw new Error(
      `SITE_ORIGIN is not a valid URL: ${JSON.stringify(origin)}`,
      { cause: error }
    );
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`SITE_ORIGIN must be http(s): ${JSON.stringify(origin)}`);
  }
  return {
    name: name.trim(),
    origin,
    gscProperty: gscProperty?.trim() || null,
    timeZone,
  };
}
