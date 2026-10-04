import { describe, expect, it } from "bun:test";
import type { MediaRow } from "@repo/db";
import { createD1MediaRepo } from "@repo/db/media";
import { createTestDb } from "@repo/db/test-utils";
import { createMediaService } from "@repo/services/cms/media-service";
import type { CmsServices } from "../../../cms/wiring.ts";
import type { Context } from "../../context.ts";
import { mediaRouter } from "./media.ts";

const ADMIN = "ada@example.com";
const ID = `${"a".repeat(64)}.png`;
const OTHER = `${"b".repeat(64)}.png`;

const row = (id: string, over: Partial<MediaRow> = {}): MediaRow => ({
  id,
  r2Key: `media/${id}`,
  sha256: id.slice(0, 64),
  mime: "image/png",
  width: 10,
  height: 20,
  alt: null,
  tags: null,
  source: "upload",
  createdAt: new Date(1000),
  ...over,
});

/** A caller over a real (in-memory SQLite) database; only what this router uses is wired. */
async function setup(userId: string | null = "u1", emails = [ADMIN]) {
  const { db } = createTestDb();
  const repo = createD1MediaRepo(db);
  await repo.insert(row(ID, { createdAt: new Date(1) }));
  await repo.insert(row(OTHER, { createdAt: new Date(2) }));
  const cms = {
    db,
    media: createMediaService({
      repo,
      blobs: { put: () => Promise.resolve() },
    }),
  } as unknown as CmsServices;
  const ctx: Context = {
    adminEmails: [ADMIN],
    auth: { userId, verifiedEmails: () => Promise.resolve(emails) },
    services: { cms },
    userId,
  };
  return mediaRouter.createCaller(ctx);
}

describe("admin gate", () => {
  it("an anonymous caller is UNAUTHORIZED", async () => {
    const caller = await setup(null, []);
    await expect(caller.listMedia({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("a signed-in non-admin is FORBIDDEN", async () => {
    const caller = await setup("u2", ["bob@example.com"]);
    await expect(caller.getMediaUsage({ id: ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a non-admin is rejected before input is parsed", async () => {
    const caller = await setup("u2", ["bob@example.com"]);
    // Invalid input: were it parsed first, this would be BAD_REQUEST.
    await expect(
      caller.updateMediaAlt({ id: "not-an-id", alt: "x" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an admin's bad input is BAD_REQUEST with the schema's message", async () => {
    const caller = await setup();
    await expect(caller.getMediaInfo({ id: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("media library", () => {
  it("lists newest first", async () => {
    const caller = await setup();
    const { items, nextCursor } = await caller.listMedia({});
    expect(items.map((m) => m.id)).toEqual([OTHER, ID]);
    expect(nextCursor).toBeNull();
  });

  it("updates alt text and tags, and reads them back", async () => {
    const caller = await setup();
    const updated = await caller.updateMediaAlt({
      id: ID,
      alt: "  A lighthouse at dusk ",
      tags: ["Sea", "sea", " dusk "],
    });
    expect(updated).toMatchObject({
      id: ID,
      alt: "A lighthouse at dusk",
      tags: ["sea", "dusk"],
    });
    expect(await caller.getMediaInfo({ id: ID })).toEqual(updated);
  });

  it("returns null for an id that isn't in the library", async () => {
    const caller = await setup();
    expect(
      await caller.getMediaInfo({ id: `${"c".repeat(64)}.png` })
    ).toBeNull();
  });

  it("reports an unused image as used nowhere", async () => {
    const caller = await setup();
    expect(await caller.getMediaUsage({ id: ID })).toEqual({
      pages: [],
      site: false,
    });
  });
});
