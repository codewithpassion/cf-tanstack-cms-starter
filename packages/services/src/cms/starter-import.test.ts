import { describe, expect, it } from "bun:test";
import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import { validatePageDoc } from "@repo/cms-core/validate";
import { createD1Repo } from "@repo/db/pages";
import { createSiteD1Repo } from "@repo/db/site";
import { createTestDb } from "@repo/db/test-utils";
import { createMemoryMediaRepo } from "../testing/media-memory-repo";
import { createMemoryKv } from "../testing/memory-kv";
import { getPage, listPages } from "./pages-service";
import { getSiteState } from "./site-service";
import { importStarterContent } from "./starter-import";

function setup() {
  const { db } = createTestDb();
  const { kv } = createMemoryKv();
  const puts: string[] = [];
  const deps = {
    pages: {
      repo: createD1Repo(db),
      kv,
      validate: validatePageDoc,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: getBlockDef returns undefined for unknown types.
      labelFor: (type: string) => getBlockDef(type)?.label ?? type,
    },
    site: { repo: createSiteD1Repo(db), kv, config: TEST_CONFIG },
    media: {
      repo: createMemoryMediaRepo().repo,
      blobs: {
        put: (key: string) => {
          puts.push(key);
          return Promise.resolve();
        },
      },
    },
  };
  return { deps, kv, puts };
}

describe("importStarterContent", () => {
  it("creates and publishes every page, the site settings and the images", async () => {
    const { deps, kv, puts } = setup();
    const result = await importStarterContent(deps);
    expect(result.site).toBe("created");
    expect(result.items).toHaveLength(7);
    expect(result.items.every((i) => i.action === "create")).toBe(true);
    expect(puts).toHaveLength(4);
    const slugs = result.items.map((item) => item.path.slice(1));
    const pages = await Promise.all(
      slugs.map((slug) => getPage(deps.pages, { slug }))
    );
    expect(pages.map((p) => p?.status)).toEqual(new Array(7).fill("published"));
    expect(await kv.get("page:about")).not.toBeNull();
    const site = await getSiteState(deps.site);
    expect(site.liveRevId).not.toBeNull();
    expect(site.liveDoc.nav.links).toHaveLength(5);
  });

  it("is idempotent: a second run creates nothing and uploads nothing", async () => {
    const { deps, puts } = setup();
    await importStarterContent(deps);
    const before = await listPages(deps.pages);
    puts.length = 0;
    const again = await importStarterContent(deps);
    expect(again.site).toBe("skipped");
    expect(again.items.every((i) => i.action === "skip")).toBe(true);
    expect(puts).toHaveLength(0);
    expect(await listPages(deps.pages)).toHaveLength(before.length);
  });

  it("skips a page that exists and leaves edited site settings alone", async () => {
    const { deps } = setup();
    await importStarterContent(deps);
    const result = await importStarterContent(deps);
    expect(result.items).toHaveLength(7);
    // Existing pages keep their ids.
    const [home] = await listPages(deps.pages).then((p) =>
      p.filter((x) => x.slug === "")
    );
    expect(result.items.find((i) => i.path === "/")?.pageId).toBe(home?.id);
  });
});
