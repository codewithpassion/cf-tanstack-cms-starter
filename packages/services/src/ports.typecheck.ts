import type { D1Db } from "@repo/db";
import { createApiKeyTable, createMcpCallLog } from "@repo/db/api-keys";
import { createD1MediaRepo } from "@repo/db/media";
import { createOauthConnectionTable } from "@repo/db/oauth-connections";
import { createD1Repo, createPageQueries } from "@repo/db/pages";
import { createSiteD1Repo } from "@repo/db/site";
import type { MediaRepo } from "./cms/media-repo";
import type { PostQueries } from "./cms/posts-admin";
import type { CmsRepo } from "./cms/repo";
import type { SiteRepo } from "./cms/site-repo";
import type {
  ApiKeyStore,
  McpCallLog,
  OauthConnectionStore,
} from "./mcp/ports";

/**
 * Type-level check, never run: each `@repo/db` factory must satisfy the port its service takes.
 * `tsc` fails here when a table module and a port drift apart.
 */
declare const db: D1Db;

export const cmsRepo: CmsRepo = createD1Repo(db);
export const siteRepo: SiteRepo = createSiteD1Repo(db);
export const mediaRepo: MediaRepo = createD1MediaRepo(db);
export const apiKeyStore: ApiKeyStore = createApiKeyTable(db);
export const mcpCallLog: McpCallLog = createMcpCallLog(db);
export const oauthConnectionStore: OauthConnectionStore =
  createOauthConnectionTable(db);

export const postQueries: PostQueries = createPageQueries(db);
