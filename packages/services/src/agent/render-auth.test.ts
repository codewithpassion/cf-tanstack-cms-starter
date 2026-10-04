import { describe, expect, it, mock } from "bun:test";
import type { PageDoc } from "@repo/cms-core/types";
import { OG_TOKEN_TTL_SECONDS, signRenderToken } from "../cms/render-token";

import { type AgentRenderPage, authorizeAgentRender } from "./render-auth";

const SECRET = "a".repeat(64);
const draftDoc = { _type: "page", title: "Draft" } as unknown as PageDoc;
const proposedDoc = { _type: "page", title: "Proposed" } as unknown as PageDoc;
const page: AgentRenderPage = {
  id: "p1",
  slug: "about",
  kind: "page",
  status: "draft",
  draftDoc,
};

function deps(found: AgentRenderPage | null = page) {
  return {
    signer: { signingKey: SECRET },
    loadPage: mock((_id: string) => Promise.resolve(found)),
    loadChangeset: mock((id: string) =>
      Promise.resolve(id === "cs1" ? { pageId: "p1", proposedDoc } : null)
    ),
  };
}

const token = (
  claims: Partial<{ slug: string; pageId: string; purpose: "og" | "preview" }>
) =>
  signRenderToken(
    { signingKey: SECRET },
    { slug: "about", purpose: "og", pageId: "p1", ...claims },
    { ttlSeconds: OG_TOKEN_TTL_SECONDS }
  );

describe("authorizeAgentRender", () => {
  it.each([
    ["no token", null],
    ["garbage", "not.a-token"],
  ])("rejects %s without reading D1", async (_label, t) => {
    const d = deps();
    expect(await authorizeAgentRender(d, "p1", t, null)).toBeNull();
    expect(d.loadPage).not.toHaveBeenCalled();
  });

  it("rejects a wrong-purpose token without reading D1", async () => {
    const d = deps();
    const t = await token({ purpose: "preview" });
    expect(await authorizeAgentRender(d, "p1", t, null)).toBeNull();
    expect(d.loadPage).not.toHaveBeenCalled();
  });

  it("rejects a token for another page without reading D1", async () => {
    const d = deps();
    const t = await token({ pageId: "p2" });
    expect(await authorizeAgentRender(d, "p1", t, null)).toBeNull();
    expect(d.loadPage).not.toHaveBeenCalled();
  });

  it("returns the draft for a valid token", async () => {
    const d = deps();
    const res = await authorizeAgentRender(d, "p1", await token({}), null);
    expect(res?.doc).toBe(draftDoc);
    expect(d.loadPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a token whose slug no longer matches the page", async () => {
    const t = await token({ slug: "old-slug" });
    expect(await authorizeAgentRender(deps(), "p1", t, null)).toBeNull();
  });

  it("rejects an archived page or one without a draft", async () => {
    const t = await token({});
    const archived = deps({ ...page, status: "archived" });
    expect(await authorizeAgentRender(archived, "p1", t, null)).toBeNull();
    const noDraft = deps({ ...page, draftDoc: null });
    expect(await authorizeAgentRender(noDraft, "p1", t, null)).toBeNull();
  });

  it("applies a changeset only when it belongs to the page", async () => {
    const t = await token({});
    const res = await authorizeAgentRender(deps(), "p1", t, "cs1");
    expect(res?.doc).toBe(proposedDoc);
    expect(await authorizeAgentRender(deps(), "p1", t, "cs2")).toBeNull();
  });

  it("fails closed when the signing key is unusable", async () => {
    const d = { ...deps(), signer: { signingKey: undefined } };
    expect(
      await authorizeAgentRender(d, "p1", await token({}), null)
    ).toBeNull();
    expect(d.loadPage).not.toHaveBeenCalled();
  });
});
