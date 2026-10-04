import { describe, expect, test } from "bun:test";
import { sampleDoc } from "@repo/cms-core/test-fixtures";
import type { PageDoc } from "@repo/cms-core/types";
import { authorizeAgentRender } from "@repo/services/agent/render-auth";
import {
  OG_TOKEN_TTL_SECONDS,
  signRenderToken,
} from "@repo/services/cms/render-token";
import { bytes } from "@repo/services/testing/media-fixtures";
import { createTestEnv, TEST_ORIGIN } from "../mcp/test-env";
import { agentRuntime } from "./agent-runtime";

const SCREENSHOT_REF_RE = /^r2:agent\/screens\/t1\/[\w-]+\.jpg$/;
const actor = { userId: "user_admin", email: "ada@example.com" };

const docAt = (slug: string): PageDoc => {
  const doc = sampleDoc();
  return { ...doc, seo: { ...doc.seo, slug } };
};

async function setup() {
  const t = createTestEnv();
  const page = await t.services.pages.createPage({
    kind: "page",
    slug: "services/a",
    title: "A",
    doc: docAt("services/a"),
  });
  const runtime = agentRuntime(t.env, t.services, { actor });
  return { ...t, page, runtime };
}

describe("agentRuntime", () => {
  test("reports no providers without the key and the binding", async () => {
    const { runtime } = await setup();
    expect(runtime.availability).toEqual({
      anthropic: false,
      workersAi: false,
    });
    expect(runtime.turnDeps.availability).toBe(runtime.availability);
    expect(runtime.toolDeps.timeZone).toBe("UTC");
  });

  test("tool deps: preview links on the site origin, screenshots in R2, media lookups", async () => {
    const { runtime, page, media, services } = await setup();
    const link = await runtime.toolDeps.previewLink({
      page,
      changesetId: null,
    });
    expect(link.url.startsWith(`${TEST_ORIGIN}/services/a?_preview=`)).toBe(
      true
    );

    const ref = await runtime.toolDeps.putScreenshot("t1", new Uint8Array([1]));
    expect(ref).toMatch(SCREENSHOT_REF_RE);
    expect(media.objects.get(ref.slice(3))).toMatchObject({
      contentType: "image/jpeg",
    });

    const { media: uploaded } = await services.media.uploadMedia({
      bytes: bytes("png"),
      alt: "A red square",
    });
    expect(await runtime.toolDeps.getMedia(uploaded.id)).toMatchObject({
      id: uploaded.id,
    });
    expect(
      (await runtime.toolDeps.searchMedia("red", 5)).map((m) => m.id)
    ).toEqual([uploaded.id]);
    expect(await runtime.toolDeps.mediaSizes([uploaded.id])).toEqual({
      [uploaded.id]: { width: uploaded.width, height: uploaded.height },
    });
    expect(await runtime.turnDeps.getMedia(uploaded.id)).toMatchObject({
      id: uploaded.id,
      mime: "image/png",
      alt: "A red square",
    });
  });

  test("tool deps: drafts, live docs and Search Console reads", async () => {
    const { runtime, page } = await setup();
    expect((await runtime.toolDeps.draftPages()).map((p) => p.id)).toEqual([
      page.id,
    ]);
    expect(await runtime.toolDeps.liveDoc(page)).toBeNull();
    const created = await runtime.toolDeps.createDraft({
      kind: "page",
      slug: "services/b",
      title: "B",
      doc: docAt("services/b"),
    });
    expect(created.status).toBe("draft");
    expect(
      await runtime.toolDeps.pagePerformance(
        { id: page.id, slug: page.slug },
        28
      )
    ).toBeTruthy();
    expect(await runtime.toolDeps.gscOverview()).toBeTruthy();
  });

  test("the admin service and Search Console run on D1", async () => {
    const { runtime, services } = await setup();
    expect(await runtime.admin.getAgentSettings()).toMatchObject({
      ok: true,
      saved: false,
    });
    expect(runtime.gsc).toBe(services.gsc);
    expect(await runtime.gsc.seoOverview()).toMatchObject({
      ok: true,
      connected: false,
    });
    expect(await runtime.gsc.submitSitemap()).toMatchObject({ ok: false });
  });

  test("the render target accepts the page's own og token only", async () => {
    const { runtime, page, services } = await setup();
    const token = await signRenderToken(
      services.signer,
      { slug: page.slug, purpose: "og", pageId: page.id },
      { ttlSeconds: OG_TOKEN_TTL_SECONDS }
    );
    expect(
      await authorizeAgentRender(runtime.renderTarget, page.id, token, null)
    ).toMatchObject({ page: { id: page.id } });
    expect(
      await authorizeAgentRender(runtime.renderTarget, "other", token, null)
    ).toBeNull();
    expect(
      await authorizeAgentRender(runtime.renderTarget, page.id, token, "nope")
    ).toBeNull();
  });

  test("suggestAltText needs ANTHROPIC_API_KEY", async () => {
    const { runtime } = await setup();
    await expect(runtime.suggestAltText("x.png")).rejects.toThrow(
      "ANTHROPIC_API_KEY"
    );
  });
});
