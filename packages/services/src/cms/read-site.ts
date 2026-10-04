// biome-ignore-all lint/style/useConsistentMethodSignatures: ported verbatim from the source (kept diffable).
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source (kept diffable).
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: `readLive` returns null for the defaults; ported verbatim from the source (kept diffable).
import type { SiteConfig } from "@repo/cms-core/site/config";
import { defaultSiteDoc, publicSite } from "@repo/cms-core/site/defaults";
import { validateSiteDoc } from "@repo/cms-core/site/schema";
import type {
  LiveSite,
  PublicSite,
  SiteDoc,
  SiteSeo,
} from "@repo/cms-core/site/types";

/** KV key of the published site doc (a `LiveSite`). */
export const SITE_KV_KEY = "site";

/** How long the public read may serve a cached KV value (seconds): a publish shows within a minute. */
export const SITE_CACHE_TTL_S = 60;

type SiteKv = {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
};

/**
 * The last KV value parsed by this isolate and its validated doc (null when invalid), so a request
 * that reads the same value skips JSON.parse and validation.
 */
let memo: { raw: string; doc: SiteDoc | null } | null = null;

function parseLive(raw: string): SiteDoc | null {
  if (memo?.raw === raw) {
    return memo.doc;
  }
  let doc: SiteDoc | null = null;
  try {
    const result = validateSiteDoc((JSON.parse(raw) as Partial<LiveSite>).doc);
    if (result.ok) {
      doc = result.doc;
    } else {
      console.error(
        "readSite: invalid site doc in KV, using the defaults",
        result.errors.slice(0, 3)
      );
    }
  } catch (err) {
    console.error(
      "readSite: unreadable site doc in KV, using the defaults",
      err
    );
  }
  memo = { raw, doc };
  return doc;
}

async function readLive(
  kv: SiteKv,
  options?: { cacheTtl: number }
): Promise<SiteDoc | null> {
  let raw: string | null;
  try {
    raw = await kv.get(SITE_KV_KEY, options);
  } catch (err) {
    console.error(
      "readSite: KV read failed, using the default site settings",
      err
    );
    return null;
  }
  return raw === null ? null : parseLive(raw);
}

/**
 * The published site doc for the public site (one KV read per request, from the root loader,
 * cached at the edge for SITE_CACHE_TTL_S). `null` means "use the defaults": nothing published, KV
 * down, or a value that no longer parses or validates (logged). The browser then renders
 * the defaults from its own bundle, so a missing doc costs no bytes in the page.
 */
export async function readSite(kv: SiteKv): Promise<PublicSite | null> {
  const doc = await readLive(kv, { cacheTtl: SITE_CACHE_TTL_S });
  return doc && publicSite(doc);
}

/**
 * The published SEO defaults (organization included) for the admin SEO tools, read without the
 * edge cache so a publish shows at once; the built-in defaults when nothing valid is published.
 */
export async function readSiteSeo(
  kv: SiteKv,
  config: SiteConfig
): Promise<SiteSeo> {
  return (await readLive(kv))?.seo ?? defaultSiteDoc(config).seo;
}
