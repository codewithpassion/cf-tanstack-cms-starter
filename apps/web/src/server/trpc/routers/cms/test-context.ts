// Test helper for the CMS router tests (never imported by app code). Builds the services the
// routers call over a real bun:sqlite D1 stand-in and an in-memory KV, without wiring.ts (which
// reads Worker bindings), and a hand-made tRPC context around them.
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import { validatePageDoc } from "@repo/cms-core/validate";
import { createD1Repo, createPageQueries } from "@repo/db/pages";
import { createSiteD1Repo } from "@repo/db/site";
import { createTestDb } from "@repo/db/test-utils";
import { createHistoryAdmin } from "@repo/services/cms/history-admin";
import { loadCmsPage } from "@repo/services/cms/load-page";
import {
  createPagesService,
  type ServiceDeps,
} from "@repo/services/cms/pages-service";
import { createPostsAdmin } from "@repo/services/cms/posts-admin";
import { createSiteService } from "@repo/services/cms/site-service";
import { createMemoryKv } from "@repo/services/testing/memory-kv";
import type { CmsServices } from "../../../cms/wiring.ts";
import type { Context } from "../../context.ts";

export const ADMIN_EMAIL = "ada@example.com";
export const ADMIN_ID = "user_admin";

/** The subset of `CmsServices` the pages, site, posts, preview and public routers use. */
export function createTestCms(author: string | null = ADMIN_ID) {
  const { db } = createTestDb();
  const { kv } = createMemoryKv();
  const signer = { signingKey: "k".repeat(64) };
  const pagesDeps: ServiceDeps = {
    repo: createD1Repo(db),
    kv,
    validate: validatePageDoc,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: getBlockDef returns undefined for retired or unknown types.
    labelFor: (type: string) => getBlockDef(type)?.label ?? type,
    author,
  };
  const queries = createPageQueries(db);
  const services = {
    config: TEST_CONFIG,
    kv,
    signer,
    pagesDeps,
    queries,
    pages: createPagesService(pagesDeps),
    history: createHistoryAdmin(pagesDeps),
    site: createSiteService({
      repo: createSiteD1Repo(db),
      kv,
      config: TEST_CONFIG,
      author,
    }),
    posts: createPostsAdmin({ pages: pagesDeps, queries, kv }),
    loadPage: (input: { path: string; preview?: string }) =>
      loadCmsPage(
        {
          kv,
          signer,
          pages: pagesDeps,
          changeset: () => Promise.resolve(null),
        },
        input
      ),
  };
  return { services, kv };
}

/**
 * A tRPC context like context.ts builds. `who`: "admin" (on ADMIN_EMAILS), "user" (signed in,
 * not an admin) or "anonymous".
 */
export function contextFor(
  who: "admin" | "user" | "anonymous",
  cms: Partial<CmsServices> | ReturnType<typeof createTestCms>["services"] = {}
): Context {
  const callers = {
    admin: { userId: ADMIN_ID, emails: [ADMIN_EMAIL] },
    user: { userId: "user_bob", emails: ["bob@example.com"] },
    anonymous: { userId: null, emails: [] },
  };
  const { userId, emails } = callers[who];
  return {
    adminEmails: [ADMIN_EMAIL],
    auth: {
      userId,
      verifiedEmails: () => Promise.resolve(userId ? emails : []),
    },
    // The routers under test reach only the services built above.
    services: { cms: cms as unknown as CmsServices },
    userId,
  };
}
