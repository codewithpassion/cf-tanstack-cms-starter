import { describe, expect, it } from "bun:test";
import { signRenderToken } from "@repo/services/cms/render-token";
import { ogRenderRouter } from "./og-render.ts";
import { pagesRouter } from "./pages.ts";
import { contextFor, createTestCms } from "./test-context.ts";

const setup = async () => {
  const { services } = createTestCms();
  const pages = pagesRouter.createCaller(contextFor("admin", services));
  await pages.createPage({ slug: "about", title: "About" });
  const og = ogRenderRouter.createCaller(contextFor("anonymous", services));
  const token = (slug: string) =>
    signRenderToken(
      services.signer,
      { slug, purpose: "og" },
      { ttlSeconds: 60 }
    );
  return { og, token };
};

describe("ogRender router", () => {
  it("returns the draft to an anonymous caller with a valid og token", async () => {
    const { og, token } = await setup();
    const data = await og.getOgRenderData({
      slug: "about",
      search: { t: await token("about"), template: "card" },
    });
    expect(data?.kind).toBe("page");
    expect(data?.params).toEqual({ template: "card" });
    expect(Array.isArray(data?.doc.blocks)).toBe(true);
  });

  it("is FORBIDDEN without a token for the slug", async () => {
    const { og, token } = await setup();
    await expect(
      og.getOgRenderData({ slug: "about", search: {} })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      og.getOgRenderData({
        slug: "about",
        search: { t: await token("other") },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is null for a page that does not exist", async () => {
    const { og, token } = await setup();
    expect(
      await og.getOgRenderData({
        slug: "missing",
        search: { t: await token("missing") },
      })
    ).toBeNull();
  });
});
