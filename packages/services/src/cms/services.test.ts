// biome-ignore-all lint/style/noNonNullAssertion: test-only; values are checked just above.
import { describe, expect, it } from "bun:test";
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { newPageDoc } from "@repo/cms-core/new-docs";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import { validatePageDoc } from "@repo/cms-core/validate";
import { createD1Repo, createPageQueries } from "@repo/db/pages";
import { createSiteD1Repo } from "@repo/db/site";
import { createTestDb } from "@repo/db/test-utils";

import { createMemoryKv } from "../testing/memory-kv";
import { loadCmsPage } from "./load-page";
import { createPagesService } from "./pages-service";
import { createPostsAdmin } from "./posts-admin";
import { signPreviewLink } from "./preview-link";
import { createSiteService } from "./site-service";

/** The real `@repo/db` table modules over bun:sqlite, the real cms-core validation, an in-memory KV. */
function setup() {
  const { db } = createTestDb();
  const { kv } = createMemoryKv();
  const pagesDeps = {
    repo: createD1Repo(db),
    kv,
    validate: validatePageDoc,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: getBlockDef returns undefined for retired or unknown types.
    labelFor: (type: string) => getBlockDef(type)?.label ?? type,
    author: "user_1",
  };
  return {
    kv,
    pagesDeps,
    pages: createPagesService(pagesDeps),
    site: createSiteService({
      repo: createSiteD1Repo(db),
      kv,
      config: TEST_CONFIG,
      author: "user_1",
    }),
    posts: createPostsAdmin({
      pages: pagesDeps,
      queries: createPageQueries(db),
      kv,
    }),
  };
}

describe("services over the D1 table modules", () => {
  it("creates, publishes and reads a page through the bound page service", async () => {
    const { pages, kv } = setup();
    const page = await pages.createPage({
      kind: "page",
      slug: "about",
      title: "About",
      doc: newPageDoc("About", "about"),
    });
    const res = await pages.publish(page.id, page.draftVersion);
    expect(res).toMatchObject({ ok: true, live: true });
    expect(JSON.parse((await kv.get("page:about"))!).kind).toBe("page");
    expect(JSON.parse((await kv.get("pages:index"))!)[0].slug).toBe("about");
  });

  it("saves and publishes the site doc, starting from the defaults", async () => {
    const { site, kv } = setup();
    const state = await site.getSiteState();
    expect(state.draftVersion).toBe(0);
    const saved = await site.saveSiteDraft(0, state.doc);
    expect(saved.draftVersion).toBe(1);
    expect(await kv.get("site")).toBeNull();
    expect(await site.publishSite(1)).toMatchObject({ ok: true, live: true });
    expect(JSON.parse((await kv.get("site"))!).doc.seo.titleTemplate).toBe(
      `%s | ${TEST_CONFIG.name}`
    );
  });

  it("creates a post and lists it with the shaped fields", async () => {
    const { posts } = setup();
    const made = await posts.create({
      title: "Hello",
      slug: "hello",
      category: "News",
      author: "Jane",
    });
    expect(made.ok).toBe(true);
    const list = await posts.list();
    expect(list.ok && list.posts[0]).toMatchObject({
      slug: "blog/hello",
      title: "Hello",
      category: "News",
      author: "Jane",
      status: "draft",
      draftChanges: false,
    });
    expect(await posts.checkSlug("hello")).toMatchObject({
      ok: false,
      code: "SLUG_TAKEN",
    });
  });
});

describe("loadCmsPage", () => {
  const signer = { signingKey: "k".repeat(64) };

  it("serves the live page, and the draft only for a valid preview token", async () => {
    const { pages, pagesDeps, kv } = setup();
    const page = await pages.createPage({
      kind: "page",
      slug: "about",
      title: "About",
      doc: newPageDoc("About", "about"),
    });
    await pages.publish(page.id, page.draftVersion);
    const deps = {
      kv,
      signer,
      pages: pagesDeps,
      changeset: () => Promise.resolve(null),
    };
    const live = await loadCmsPage(deps, { path: "/about" });
    expect("page" in live && live.page).toBeTruthy();
    expect("preview" in live).toBe(false);

    const { path } = await signPreviewLink(signer, page, { ttlSeconds: 60 });
    const token = new URL(path, "https://example.com").searchParams.get(
      "_preview"
    )!;
    const preview = await loadCmsPage(deps, { path: "/about", preview: token });
    expect(preview).toMatchObject({ preview: true });
    const bad = await loadCmsPage(deps, { path: "/about", preview: "nope" });
    expect("preview" in bad).toBe(false);
  });
});
