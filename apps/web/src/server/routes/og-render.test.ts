import { describe, expect, it } from "bun:test";
import { sampleDoc } from "@repo/cms-core/test-fixtures";
import { signRenderToken } from "@repo/services/cms/render-token";
import {
  checkOgRequest,
  type OgRenderDeps,
  readOgRenderData,
} from "./og-render";

const signer = { signingKey: "k".repeat(32) };

const token = (slug: string, purpose: "og" | "preview" = "og") =>
  signRenderToken(signer, { slug, purpose }, { ttlSeconds: 60 });

const url = (path: string, query: Record<string, string>) =>
  new URL(`https://example.com${path}?${new URLSearchParams(query)}`);

describe("og-render request gate", () => {
  it("lets a valid og token for the slug through", async () => {
    const t = await token("about");
    expect(await checkOgRequest(signer, url("/og-render/about", { t }))).toBe(
      null
    );
    const home = await token("");
    expect(await checkOgRequest(signer, url("/og-render", { t: home }))).toBe(
      null
    );
  });

  it("answers 403 for a missing, foreign or wrong-purpose token", async () => {
    const cases = [
      url("/og-render/about", {}),
      url("/og-render/about", { t: await token("other") }),
      url("/og-render/about", { t: await token("about", "preview") }),
      url("/og-render/about", { t: "garbage" }),
    ];
    for (const u of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose; a handful of cheap checks.
      const res = await checkOgRequest(signer, u);
      expect(res?.status).toBe(403);
      expect(res?.headers.get("Cache-Control")).toBe("no-store");
      expect(res?.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });

  it("fails closed without a usable signing key", async () => {
    const t = await token("about");
    const res = await checkOgRequest(
      { signingKey: undefined },
      url("/og-render/about", { t })
    );
    expect(res?.status).toBe(403);
  });

  it("answers 400 for bad template parameters", async () => {
    const t = await token("about");
    const res = await checkOgRequest(
      signer,
      url("/og-render/about", { t, template: "nope" })
    );
    expect(res?.status).toBe(400);
  });
});

describe("readOgRenderData", () => {
  const doc = sampleDoc();
  const deps = (found: boolean): OgRenderDeps => ({
    signer,
    findPage: (slug) =>
      Promise.resolve(
        found && slug === "about" ? { draftDoc: doc, kind: "page" } : null
      ),
  });

  it("returns the draft and the parsed parameters", async () => {
    const t = await token("about");
    expect(
      await readOgRenderData(deps(true), {
        slug: "about",
        search: { t, template: "card" },
      })
    ).toEqual({ ok: true, doc, kind: "page", params: { template: "card" } });
  });

  it("re-checks the token: the procedure is reachable without the gate", async () => {
    const result = await readOgRenderData(deps(true), {
      slug: "about",
      search: { t: await token("other") },
    });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    const invalid = await readOgRenderData(deps(true), {
      slug: "../x",
      search: { t: await token("about") },
    });
    expect(invalid).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("reports bad parameters and a missing page", async () => {
    const t = await token("about");
    expect(
      await readOgRenderData(deps(true), {
        slug: "about",
        search: { t, template: "nope" },
      })
    ).toMatchObject({ ok: false, reason: "bad-params" });
    expect(
      await readOgRenderData(deps(false), { slug: "about", search: { t } })
    ).toMatchObject({ ok: false, reason: "not-found" });
  });
});
