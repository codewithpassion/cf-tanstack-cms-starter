import { describe, expect, it } from "bun:test";
import type { PageDoc } from "@repo/cms-core/types";
import type {
  AgentRenderDeps,
  AgentRenderPage,
} from "@repo/services/agent/render-auth";
import { signRenderToken } from "@repo/services/cms/render-token";
import {
  agentRenderPageId,
  checkAgentRenderRequest,
  readAgentRenderData,
} from "./og-render-agent";

const signer = { signingKey: "k".repeat(64) };
const draftDoc = { title: "Draft", blocks: [] } as unknown as PageDoc;
const proposedDoc = { title: "Proposed", blocks: [] } as unknown as PageDoc;
const page: AgentRenderPage = {
  id: "p1",
  slug: "about",
  kind: "page",
  status: "draft",
  draftDoc,
};

const deps: AgentRenderDeps = {
  signer,
  loadPage: (id) => Promise.resolve(id === "p1" ? page : null),
  loadChangeset: (id) =>
    Promise.resolve(id === "cs1" ? { pageId: "p1", proposedDoc } : null),
};

const token = (claims: { slug?: string; pageId?: string } = {}) =>
  signRenderToken(
    signer,
    { slug: "about", pageId: "p1", purpose: "og", ...claims },
    { ttlSeconds: 60 }
  );

const url = (path: string, query = "") =>
  new URL(`https://example.com${path}${query}`);

describe("agent render gate", () => {
  it("reads the page id from the path", () => {
    expect(agentRenderPageId("/og-render-agent/p1")).toBe("p1");
    expect(agentRenderPageId("/og-render-agent/")).toBeNull();
    expect(agentRenderPageId("/og-render/p1")).toBeNull();
    expect(agentRenderPageId("/og-render-agent/%E0%A4%A")).toBeNull();
  });

  it("lets a valid token for the page through, with or without its changeset", async () => {
    const t = await token();
    expect(
      await checkAgentRenderRequest(deps, url("/og-render-agent/p1", `?t=${t}`))
    ).toBeNull();
    expect(
      await checkAgentRenderRequest(
        deps,
        url("/og-render-agent/p1", `?t=${t}&cs=cs1`)
      )
    ).toBeNull();
  });

  it("answers 403, no-store and noindex, otherwise", async () => {
    const other = await token({ pageId: "p2" });
    const valid = await token();
    for (const [path, query] of [
      ["/og-render-agent/p1", ""],
      ["/og-render-agent/p1", `?t=${other}`],
      ["/og-render-agent/p1", `?t=${valid}&cs=missing`],
      ["/og-render-agent/", `?t=${valid}`],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: a few cases, checked one by one.
      const res = await checkAgentRenderRequest(deps, url(path, query));
      expect(res?.status).toBe(403);
      expect(res?.headers.get("Cache-Control")).toBe("no-store");
      expect(res?.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });
});

describe("readAgentRenderData", () => {
  it("returns the draft, or the proposal `cs` names", async () => {
    const t = await token();
    expect(
      await readAgentRenderData(deps, { pageId: "p1", search: { t } })
    ).toEqual({ doc: draftDoc, kind: "page" });
    expect(
      await readAgentRenderData(deps, {
        pageId: "p1",
        search: { t, cs: "cs1" },
      })
    ).toEqual({ doc: proposedDoc, kind: "page" });
  });

  it("is null for a token minted for another slug", async () => {
    expect(
      await readAgentRenderData(deps, {
        pageId: "p1",
        search: { t: await token({ slug: "old-slug" }) },
      })
    ).toBeNull();
  });
});
