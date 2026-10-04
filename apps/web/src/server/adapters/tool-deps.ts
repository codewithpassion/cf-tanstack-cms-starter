/**
 * The agent's `ToolDeps` (docs/cms-plan.md §4.3) over the CMS services and the Worker's R2 and
 * Browser Run bindings: the web port of the source's agent/server/wiring.ts `toolDeps(env, origin)`.
 * Shared by the AI tab's turns and the MCP server. Builds no model client, so it works without
 * ANTHROPIC_API_KEY. Absolute links use the site origin (`cms.config.origin`).
 */
import { pageUrl } from "@repo/cms-core/gsc/shape";
import { mediaSizes } from "@repo/db/media";
import type { ToolDeps } from "@repo/services/agent/tools";
import { AGENT_SCREENS_PREFIX } from "@repo/services/cms/media-bytes";
import { signPreviewLink } from "@repo/services/cms/preview-link";
import { readSiteSeo } from "@repo/services/cms/read-site";
import { AGENT_PREVIEW_TTL_SECONDS } from "@repo/services/cms/render-token";
import { createD1GscQueries } from "@repo/services/gsc/d1";
import { nanoid } from "nanoid";
import type { CmsServices } from "../cms/wiring";
import { renderPreview } from "./browser-render";
import { type BrowserBinding, createShareImage } from "./share-image";

/** The part of R2 the tools write (agent screenshots). */
export type ScreenshotBlobs = {
  put: (
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string } }
  ) => Promise<unknown>;
};

/** The bindings the tools use beyond `cmsServices`. */
export type ToolEnv = {
  BROWSER?: BrowserBinding;
  CMS_MEDIA: ScreenshotBlobs;
};

export function agentToolDeps(env: ToolEnv, cms: CmsServices): ToolDeps {
  const { config } = cms;
  const gsc = createD1GscQueries(cms.db);
  const urlOf = (slug: string) => pageUrl(slug, config);
  return {
    store: cms.agentStore,
    config,
    timeZone: config.timeZone,
    pageBySlug: (slug) => cms.pages.getPage({ slug }),
    pageById: (id) => cms.pages.getPage({ id }),
    liveDoc: async (page) =>
      page.status === "published" && page.liveRevId
        ? ((await cms.pagesDeps.repo.getRevision(page.liveRevId))?.docJson ??
          null)
        : null,
    listPages: () => cms.pages.listPages(),
    draftPages: () => cms.queries.draftPages(),
    siteSeo: () => readSiteSeo(cms.kv, config),
    mediaSizes: (ids) => mediaSizes(cms.db, ids),
    async searchMedia(query, limit) {
      const res = await cms.media.listMedia({ query });
      return res.items.slice(0, limit);
    },
    getMedia: (id) => cms.media.getMedia(id),
    pagePerformance: (page, days) =>
      gsc.pagePerformance(page, days, { pageUrl: urlOf }),
    gscOverview: () => gsc.seoGscOverview({ pageUrl: urlOf }),
    renderPreview: (input) =>
      renderPreview(
        { browser: env.BROWSER, signer: cms.signer, origin: config.origin },
        input
      ),
    shareImage: (input) =>
      createShareImage(env, cms, { ...input, source: "agent" }),
    async createDraft(input) {
      await cms.pages.checkSlugAvailable(input.kind, input.slug);
      return await cms.pages.createPage(input);
    },
    async previewLink({ page, changesetId }) {
      const link = await signPreviewLink(cms.signer, page, {
        ttlSeconds: AGENT_PREVIEW_TTL_SECONDS,
        ...(changesetId && { changesetId }),
      });
      return { url: `${config.origin}${link.path}`, expiresAt: link.expiresAt };
    },
    async putScreenshot(threadId, bytes) {
      const key = `${AGENT_SCREENS_PREFIX}${threadId}/${nanoid()}.jpg`;
      await env.CMS_MEDIA.put(key, bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      return `r2:${key}`;
    },
  };
}
