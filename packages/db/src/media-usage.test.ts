import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { mediaUsage } from "./media.ts";
import { pages, revisions, site, siteRevisions } from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const docWith = (...ids: string[]) =>
  ({
    _schema: 1,
    blocks: ids.map((id) => ({
      type: "image",
      props: { image: { mediaId: id, alt: "" } },
    })),
  }) as never;

describe("mediaUsage (SQL)", () => {
  it("finds pages by draft and live version, skips archived ones, and checks the site doc", async () => {
    const { db } = createTestDb();
    const at = new Date(0);
    await db.insert(pages).values([
      {
        id: "p-live",
        kind: "page",
        slug: "live",
        title: "Live only",
        status: "published",
        draftDoc: docWith(),
        updatedAt: at,
      },
      {
        id: "p-draft",
        kind: "page",
        slug: "draft",
        title: "Draft only",
        status: "published",
        draftDoc: docWith(A),
        updatedAt: at,
      },
      {
        id: "p-new",
        kind: "page",
        slug: "new",
        title: "Never published",
        status: "draft",
        draftDoc: docWith(A),
        updatedAt: at,
      },
      {
        id: "p-arch",
        kind: "page",
        slug: "gone",
        title: "Archived",
        status: "archived",
        draftDoc: docWith(A),
        updatedAt: at,
      },
      {
        id: "p-other",
        kind: "page",
        slug: "other",
        title: "Other image",
        status: "draft",
        draftDoc: docWith(B),
        updatedAt: at,
      },
    ]);
    await db.insert(revisions).values([
      {
        id: "r-live",
        pageId: "p-live",
        docJson: docWith(A),
        kind: "published",
        createdAt: at,
      },
      {
        id: "r-old",
        pageId: "p-draft",
        docJson: docWith(),
        kind: "published",
        createdAt: at,
      },
    ]);
    await db
      .update(pages)
      .set({ liveRevId: "r-live" })
      .where(eq(pages.id, "p-live"));
    await db
      .update(pages)
      .set({ liveRevId: "r-old" })
      .where(eq(pages.id, "p-draft"));
    await db.insert(siteRevisions).values({
      id: "s1",
      docJson: { shareImage: { mediaId: B } } as never,
      kind: "published",
      createdAt: at,
    });
    await db.insert(site).values({
      id: "site",
      draftDoc: {} as never,
      liveRevId: "s1",
      updatedAt: at,
    });

    const a = await mediaUsage(db, A);
    expect(a.site).toBe(false);
    expect(a.pages.map((p) => [p.slug, p.inDraft, p.inLive])).toEqual([
      ["draft", true, false],
      ["live", false, true],
      ["new", true, false],
    ]);
    const b = await mediaUsage(db, B);
    expect(b.site).toBe(true);
    expect(b.pages.map((p) => p.slug)).toEqual(["other"]);
  });

  // Not in the source: this repo's event blocks store a bare media id (bio `photo`) and posts keep
  // theirs in `post.featuredImage`; the substring match must find both.
  it("finds an event block's bio photo and a post's featured image", async () => {
    const { db } = createTestDb();
    const at = new Date(0);
    const photo = `${"c".repeat(64)}.jpg`;
    const featured = `${"d".repeat(64)}.webp`;
    await db.insert(pages).values([
      {
        id: "p-event",
        kind: "page",
        slug: "events/meetup",
        title: "Meetup",
        status: "draft",
        draftDoc: {
          _schema: 1,
          blocks: [
            { _key: "hero", _type: "eventHero", _v: 1, props: {} },
            {
              _key: "bio",
              _type: "bio",
              _v: 1,
              props: { name: "Speaker", photo },
            },
          ],
        } as never,
        updatedAt: at,
      },
      {
        id: "p-post",
        kind: "post",
        slug: "blog/hello",
        title: "Hello",
        status: "draft",
        draftDoc: {
          _schema: 1,
          blocks: [],
          post: { featuredImage: { mediaId: featured, alt: "" } },
        } as never,
        updatedAt: at,
      },
    ]);

    const usedByEvent = await mediaUsage(db, photo);
    expect(usedByEvent.pages.map((p) => [p.slug, p.inDraft])).toEqual([
      ["events/meetup", true],
    ]);
    const usedByPost = await mediaUsage(db, featured);
    expect(usedByPost.pages.map((p) => p.slug)).toEqual(["blog/hello"]);
    expect(usedByPost.site).toBe(false);
  });
});
