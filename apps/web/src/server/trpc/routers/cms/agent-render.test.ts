import { describe, expect, it } from "bun:test";
import { createMemoryAgentStore } from "@repo/services/agent/memory-store";
import { signRenderToken } from "@repo/services/cms/render-token";
import { agentRenderRouter } from "./agent-render.ts";
import { pagesRouter } from "./pages.ts";
import { contextFor, createTestCms } from "./test-context.ts";

const setup = async () => {
  const { services } = createTestCms();
  const cms = { ...services, agentStore: createMemoryAgentStore() };
  const pages = pagesRouter.createCaller(contextFor("admin", cms));
  const created = await pages.createPage({ slug: "about", title: "About" });
  if (!created.ok) {
    throw new Error(created.message);
  }
  const caller = agentRenderRouter.createCaller(contextFor("anonymous", cms));
  const token = (claims: { slug?: string; pageId?: string } = {}) =>
    signRenderToken(
      services.signer,
      { slug: "about", pageId: created.id, purpose: "og", ...claims },
      { ttlSeconds: 60 }
    );
  return { caller, token, pageId: created.id };
};

describe("agentRender router", () => {
  it("returns the draft to an anonymous caller with a valid token for the page", async () => {
    const { caller, token, pageId } = await setup();
    const data = await caller.getAgentRenderData({
      pageId,
      search: { t: await token() },
    });
    expect(data.kind).toBe("page");
    expect(Array.isArray(data.doc.blocks)).toBe(true);
    expect(data.posts).toEqual([]);
  });

  it("is FORBIDDEN without a token for this page, or for a changeset that doesn't exist", async () => {
    const { caller, token, pageId } = await setup();
    await expect(
      caller.getAgentRenderData({ pageId, search: {} })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.getAgentRenderData({
        pageId,
        search: { t: await token({ pageId: "other" }) },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.getAgentRenderData({
        pageId,
        search: { t: await token(), cs: "missing" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
