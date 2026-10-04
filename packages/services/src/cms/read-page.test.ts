// biome-ignore-all lint/performance/noAwaitInLoops: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noShadow: ported verbatim from the source test (kept diffable); test-only idiom.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import {
  type PreviewDeps,
  readCmsPage,
  readPreviewPage,
  withPosts,
} from "./read-page";
import { signRenderToken, verifyRenderToken } from "./render-token";

const kvOf = (entries: Record<string, string>) => ({
  get: async (key: string) => entries[key] ?? null,
});

describe("readCmsPage", () => {
  afterEach(() => mock.restore());

  it("returns the live page, else the redirect, else a miss", async () => {
    const kv = kvOf({
      "page:services/a": '{"revId":"r1"}',
      "redirect:services/old": "services/a",
    });
    expect(await readCmsPage(kv, "/services/a")).toEqual({
      page: '{"revId":"r1"}',
      parents: [],
    });
    expect(await readCmsPage(kv, "/services/old")).toEqual({
      redirect: "/services/a",
    });
    expect(await readCmsPage(kv, "/services/none")).toEqual({ page: null });
    expect(await readCmsPage(kv, "/Services/A/")).toEqual({
      redirect: "/services/a",
    });
  });

  it("lists the page's CMS parents from pages:index, only when a parent isn't a static page", async () => {
    const index = JSON.stringify(
      ["guides", "guides/a", "login"].map((slug) => ({ slug }))
    );
    const kv = {
      get: mock(
        kvOf({
          "page:guides/a/b": "{}",
          "page:login/x": "{}",
          "pages:index": index,
        }).get
      ),
    };
    expect(await readCmsPage(kv, "/guides/a/b")).toEqual({
      page: "{}",
      parents: ["guides", "guides/a"],
    });
    kv.get.mockClear();
    expect(await readCmsPage(kv, "/login/x")).toEqual({
      page: "{}",
      parents: [],
    });
    expect(kv.get).toHaveBeenCalledTimes(1); // "login" is a static page: no index read
  });

  it("treats a malformed redirect target as a miss", async () => {
    for (const target of [
      "https://evil.example",
      "/abs",
      "a//b",
      "Upper",
      "a b",
      "../x",
    ]) {
      expect(
        await readCmsPage(kvOf({ "redirect:old": target }), "/old")
      ).toEqual({ page: null });
    }
    expect(await readCmsPage(kvOf({ "redirect:old": "" }), "/old")).toEqual({
      redirect: "/",
    });
  });

  it("logs a KV failure and reports a miss so routes fall back", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const kv = { get: async () => Promise.reject(new Error("KV unavailable")) };
    expect(await readCmsPage(kv, "/services/a")).toEqual({ page: null });
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("readPreviewPage", () => {
  const SECRET = "x".repeat(64);
  const PAGE_A = "page_a";
  const draftDoc = { seo: { slug: "services/a" }, blocks: [] };
  const proposedDoc = {
    seo: { slug: "services/a" },
    blocks: [{ _key: "new", _type: "hero" }],
  };
  const CHANGESETS: Record<
    string,
    { pageId: string; status: string; doc: unknown }
  > = {
    cs_pending: { pageId: PAGE_A, status: "pending", doc: proposedDoc },
    cs_accepted: { pageId: PAGE_A, status: "accepted", doc: proposedDoc },
    cs_other_page: {
      pageId: "page_b",
      status: "pending",
      doc: { seo: { slug: "services/b" }, blocks: [] },
    },
  };
  const csToken = (changesetId: string) =>
    signRenderToken(
      { signingKey: SECRET },
      { slug: "services/a", purpose: "preview", pageId: PAGE_A, changesetId },
      { ttlSeconds: 60 * 60 }
    );
  const verifyWith =
    (secret: string | undefined) => async (slug: string, token: string) => {
      const res = await verifyRenderToken({ signingKey: secret }, token, {
        slug,
        purpose: "preview",
      });
      return res.ok ? res.claims : null;
    };
  const deps = (over: Partial<PreviewDeps> = {}): PreviewDeps => ({
    kv: kvOf({}),
    verify: verifyWith(SECRET),
    draft: async (slug) =>
      slug === "services/a" ? { id: PAGE_A, doc: draftDoc } : null,
    changeset: async (id) => CHANGESETS[id] ?? null,
    ...over,
  });
  /** `pageId: null` mints a token without one (as before tokens were bound to pages). */
  const token = (
    slug: string,
    purpose: "preview" | "og" = "preview",
    pageId: string | null = PAGE_A
  ) =>
    signRenderToken(
      { signingKey: SECRET },
      { slug, purpose, ...(pageId !== null && { pageId }) },
      { ttlSeconds: purpose === "og" ? 60 : 24 * 60 * 60 }
    );

  afterEach(() => mock.restore());

  it("returns the draft, flagged as a preview, for a valid token bound to the path's slug and page", async () => {
    expect(
      await readPreviewPage(deps(), "/services/a", await token("services/a"))
    ).toEqual({
      page: JSON.stringify({ doc: draftDoc }),
      parents: [],
      preview: true,
    });
  });

  it("ignores tokens for another page, another purpose, bad signatures and expired tokens", async () => {
    const d = deps();
    expect(
      await readPreviewPage(d, "/services/a", await token("services/b"))
    ).toBeNull();
    expect(
      await readPreviewPage(d, "/services/a", await token("services/a", "og"))
    ).toBeNull();
    expect(await readPreviewPage(d, "/services/a", "garbage")).toBeNull();
    const other = await signRenderToken(
      { signingKey: "y".repeat(64) },
      { slug: "services/a", purpose: "preview", pageId: PAGE_A },
      { ttlSeconds: 60 }
    );
    expect(await readPreviewPage(d, "/services/a", other)).toBeNull();
    const old = await signRenderToken(
      { signingKey: SECRET },
      { slug: "services/a", purpose: "preview", pageId: PAGE_A },
      { ttlSeconds: 60, now: Date.now() - 120_000 }
    );
    expect(await readPreviewPage(d, "/services/a", old)).toBeNull();
  });

  it("refuses a token minted for another page that held the slug (slug swap), and tokens without a page id", async () => {
    // Page A's link was minted while A was at services/a; page B holds services/a now.
    const swapped = deps({
      draft: async () => ({
        id: "page_b",
        doc: { seo: { slug: "services/a" }, blocks: [] },
      }),
    });
    expect(
      await readPreviewPage(swapped, "/services/a", await token("services/a"))
    ).toBeNull();
    expect(
      await readPreviewPage(
        deps(),
        "/services/a",
        await token("services/a", "preview", null)
      )
    ).toBeNull();
  });

  it("reads no draft unless the token is valid, and only the token's page", async () => {
    const draft = mock(async () => ({ id: PAGE_A, doc: draftDoc }));
    await readPreviewPage(deps({ draft }), "/services/a", "garbage");
    expect(draft).not.toHaveBeenCalled();
    await readPreviewPage(
      deps({ draft }),
      "/services/a",
      await token("services/a", "preview", null)
    );
    expect(draft).not.toHaveBeenCalled();
    await readPreviewPage(
      deps({ draft }),
      "/services/a",
      await token("services/a")
    );
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledWith("services/a");
  });

  it("is a miss for non-canonical paths, pages without a draft, and failed reads", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(
      await readPreviewPage(deps(), "/Services/A/", await token("services/a"))
    ).toBeNull();
    expect(
      await readPreviewPage(deps(), "/services/b", await token("services/b"))
    ).toBeNull();
    expect(
      await readPreviewPage(
        deps({ draft: async () => ({ id: PAGE_A, doc: null }) }),
        "/services/a",
        await token("services/a")
      )
    ).toBeNull();
    const failing = deps({ draft: () => Promise.reject(new Error("D1 down")) });
    expect(
      await readPreviewPage(failing, "/services/a", await token("services/a"))
    ).toBeNull();
    expect(
      await readPreviewPage(failing, "/services/a", await token("services/a"))
    ).toBeNull();
    expect(error).toHaveBeenCalledTimes(2); // every D1 failure is logged
  });

  it("logs a missing signing key once, not on every preview request", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const noKey = deps({ verify: verifyWith(undefined) });
    for (let i = 0; i < 3; i++) {
      expect(
        await readPreviewPage(noKey, "/services/a", await token("services/a"))
      ).toBeNull();
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![1])).toMatch(/PREVIEW_SIGNING_KEY/);
  });

  it("previews a blog post at /blog/<slug> (blog is a static page, not a CMS parent)", async () => {
    const postDraft = { seo: { slug: "blog/a" }, post: {}, blocks: [] };
    const d = deps({
      draft: async (slug) =>
        slug === "blog/a" ? { id: PAGE_A, doc: postDraft } : null,
    });
    expect(await readPreviewPage(d, "/blog/a", await token("blog/a"))).toEqual({
      page: JSON.stringify({ doc: postDraft }),
      parents: [],
      preview: true,
    });
    expect(
      await readPreviewPage(d, "/blog/a", await token("services/a"))
    ).toBeNull();
  });

  it("shows a pending changeset of the token's page, and is a miss for any other changeset", async () => {
    expect(
      await readPreviewPage(deps(), "/services/a", await csToken("cs_pending"))
    ).toEqual({
      page: JSON.stringify({ doc: proposedDoc }),
      parents: [],
      preview: true,
    });
    for (const id of ["cs_accepted", "cs_other_page", "cs_missing"]) {
      expect(
        await readPreviewPage(deps(), "/services/a", await csToken(id))
      ).toEqual({ page: null });
    }
    // The changeset is only read after the token and the page check out.
    const changeset = mock(async () => CHANGESETS.cs_pending!);
    const swapped = deps({
      changeset,
      draft: async () => ({ id: "page_b", doc: draftDoc }),
    });
    expect(
      await readPreviewPage(swapped, "/services/a", await csToken("cs_pending"))
    ).toBeNull();
    expect(changeset).not.toHaveBeenCalled();
  });

  it('previews the home page (slug "") and lists CMS parents of nested pages', async () => {
    const index = JSON.stringify([{ slug: "guides" }]);
    const d = deps({
      kv: kvOf({ "pages:index": index }),
      draft: async () => ({ id: PAGE_A, doc: draftDoc }),
    });
    expect(await readPreviewPage(d, "/", await token(""))).toMatchObject({
      preview: true,
      parents: [],
    });
    expect(
      await readPreviewPage(d, "/guides/a", await token("guides/a"))
    ).toMatchObject({ preview: true, parents: ["guides"] });
  });
});

describe("withPosts", () => {
  afterEach(() => mock.restore());
  const index = '[{"slug":"blog/a"}]';
  const withList = JSON.stringify({
    doc: { blocks: [{ _key: "p", _type: "postList", props: {} }] },
  });

  it("adds posts:index to a page with a postList block, and reads nothing for other pages", async () => {
    const get = mock(async (key: string) =>
      key === "posts:index" ? index : null
    );
    expect(await withPosts({ get }, { page: withList, parents: [] })).toEqual({
      page: withList,
      parents: [],
      posts: index,
    });
    get.mockClear();
    const plain = {
      page: JSON.stringify({ doc: { blocks: [{ _type: "hero" }] } }),
      parents: [],
    };
    expect(await withPosts({ get }, plain)).toBe(plain);
    expect(await withPosts({ get }, { page: null })).toEqual({ page: null });
    expect(await withPosts({ get }, { redirect: "/x" })).toEqual({
      redirect: "/x",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("leaves the page as it is when posts:index is missing or KV fails", async () => {
    expect(
      await withPosts(
        { get: async () => null },
        { page: withList, parents: [] }
      )
    ).toEqual({ page: withList, parents: [] });
    spyOn(console, "error").mockImplementation(() => {});
    expect(
      await withPosts(
        { get: () => Promise.reject(new Error("down")) },
        { page: withList, parents: [] }
      )
    ).toEqual({ page: withList, parents: [] });
  });
});
