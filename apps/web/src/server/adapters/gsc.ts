import {
  createGscClient,
  type GscClient,
  gscCredentials,
} from "@repo/services/gsc/client";

/** The secrets and property the Search Console client needs (a Worker's `env`, or a script's `getPlatformProxy` env). */
export type GscEnv = {
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REFRESH_TOKEN?: string;
  GSC_PROPERTY?: string;
};

/**
 * The Search Console client, or null when it isn't connected: any of the three GSC secrets or the
 * `GSC_PROPERTY` var is missing. "Connected" everywhere (the SEO tab, /admin/setup, the cron) means
 * this is non-null. Building it does no I/O.
 */
export function gscClientFor(env: GscEnv): GscClient | null {
  const credentials = gscCredentials(env);
  const property = env.GSC_PROPERTY?.trim();
  return credentials && property
    ? createGscClient({ credentials, property })
    : null;
}
