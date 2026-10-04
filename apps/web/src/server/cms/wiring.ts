// Builds every CMS service from the Worker bindings (docs/architecture.md, D20). Nothing in
// @repo/services reads `env`; this is the one place the Cloudflare bindings meet the ports.
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { type SiteConfig, siteConfig } from "@repo/cms-core/site/config";
import { validatePageDoc } from "@repo/cms-core/validate";
// biome-ignore lint/performance/noNamespaceImport: drizzle needs every table for its relational query API.
import * as schema from "@repo/db";
import { createD1AgentStore } from "@repo/db/agent-store";
import { createApiKeyTable, createMcpCallLog } from "@repo/db/api-keys";
import { createD1MediaRepo } from "@repo/db/media";
import { createOauthConnectionTable } from "@repo/db/oauth-connections";
import { createD1Repo, createPageQueries } from "@repo/db/pages";
import { createSiteD1Repo } from "@repo/db/site";
import { createHistoryAdmin } from "@repo/services/cms/history-admin";
import { type CmsPageResult, loadCmsPage } from "@repo/services/cms/load-page";
import { createMediaService } from "@repo/services/cms/media-service";
import {
  createPagesService,
  type ServiceDeps,
} from "@repo/services/cms/pages-service";
import { createPostsAdmin } from "@repo/services/cms/posts-admin";
import type { RenderSigner } from "@repo/services/cms/render-token";
import { createSiteService } from "@repo/services/cms/site-service";
import { createGscAdmin } from "@repo/services/gsc/admin";
import { createD1GscQueries, createD1GscStore } from "@repo/services/gsc/d1";
import { createConnectionsService } from "@repo/services/mcp/connections";
import { createApiKeysService } from "@repo/services/mcp/keys";
import { drizzle } from "drizzle-orm/d1";
import { gscClientFor } from "../adapters/gsc";

export type CmsWiringOptions = {
  /** The request being served. Its origin is the site origin in dev when SITE_ORIGIN is empty. */
  request?: Request | null;
  /** Recorded as `author` on the revisions the services write: the Clerk user id, or `mcpAuthor(key)`. */
  author?: string | null;
};

/**
 * `SITE_ORIGIN` is required in production (D16): an empty one throws instead of silently serving
 * request-derived URLs, which the Host header controls. Only `bun run dev` falls back to the
 * request origin.
 */
export const resolveSiteConfig = (
  env: Env,
  request?: Request | null
): SiteConfig => {
  const configured = env.SITE_ORIGIN.trim();
  const fallback =
    import.meta.env.DEV && request ? new URL(request.url).origin : "";
  return siteConfig({
    name: env.SITE_NAME,
    origin: configured || fallback,
    gscProperty: env.GSC_PROPERTY,
    timeZone: env.SITE_TIME_ZONE,
  });
};

/** The registry label; retired or unknown types fall back to the raw type name. */
// biome-ignore lint/suspicious/noUnnecessaryConditions: getBlockDef returns undefined for retired or unknown types.
const labelFor = (type: string): string => getBlockDef(type)?.label ?? type;

export const createDb = (env: Env) => drizzle(env.DB, { schema });

export const cmsServices = (env: Env, options: CmsWiringOptions = {}) => {
  const { author = null, request = null } = options;
  const db = createDb(env);
  const config = resolveSiteConfig(env, request);
  const kv = env.CMS_PAGES;
  const signer: RenderSigner = { signingKey: env.PREVIEW_SIGNING_KEY };
  const agentStore = createD1AgentStore(db);

  const pagesDeps: ServiceDeps = {
    repo: createD1Repo(db),
    kv,
    validate: validatePageDoc,
    labelFor,
    author,
  };
  const queries = createPageQueries(db);
  const gscClient = gscClientFor(env);
  const keys = createApiKeysService({
    keys: createApiKeyTable(db),
    calls: createMcpCallLog(db),
  });

  return {
    db,
    config,
    kv,
    signer,
    pagesDeps,
    queries,
    agentStore,
    /** The origin the browser used, for MCP URLs and key environments. Null outside a request. */
    requestOrigin: request ? new URL(request.url).origin : null,
    /** The raw `SITE_ORIGIN` var (empty when unset). `keyEnvFor` needs it, not `config.origin`. */
    siteOriginVar: env.SITE_ORIGIN,
    pages: createPagesService(pagesDeps),
    history: createHistoryAdmin(pagesDeps),
    site: createSiteService({
      repo: createSiteD1Repo(db),
      kv,
      config,
      author,
    }),
    posts: createPostsAdmin({
      pages: pagesDeps,
      queries,
      kv,
      timeZone: config.timeZone,
    }),
    media: createMediaService({
      repo: createD1MediaRepo(db),
      blobs: env.CMS_MEDIA,
    }),
    apiKeys: keys,
    connections: createConnectionsService({
      connections: createOauthConnectionTable(db),
    }),
    /** The Search Console client; null when the GSC secrets or `GSC_PROPERTY` aren't set. */
    gscClient,
    gscConfigured: gscClient !== null,
    /** Search Console reads (D1) and the two Google calls ("Inspect now", "Resubmit sitemap"). */
    gsc: createGscAdmin({
      queries: createD1GscQueries(db),
      pages: pagesDeps.repo,
      store: createD1GscStore(db),
      client: gscClient,
      config,
      log: console.log,
    }),
    /** The public page loader: published page from KV, or a draft/proposal behind a preview token. */
    loadPage: (input: {
      path: string;
      preview?: string;
    }): Promise<CmsPageResult> =>
      loadCmsPage(
        {
          kv,
          signer,
          pages: pagesDeps,
          changeset: async (id) => {
            const row = await agentStore.getChangeset(id);
            return row
              ? { pageId: row.pageId, status: row.status, doc: row.proposedDoc }
              : null;
          },
        },
        input
      ),
  };
};

export type CmsServices = ReturnType<typeof cmsServices>;
