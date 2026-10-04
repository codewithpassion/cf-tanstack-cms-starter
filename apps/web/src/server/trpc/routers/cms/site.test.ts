// biome-ignore-all lint/style/noNonNullAssertion: test-only; values are checked just above.
import { describe, expect, it } from "bun:test";
import { siteRouter } from "./site.ts";
import { contextFor, createTestCms } from "./test-context.ts";

function setup() {
  const { services, kv } = createTestCms();
  return { kv, caller: siteRouter.createCaller(contextFor("admin", services)) };
}

describe("site router: admin gate", () => {
  it("answers an anonymous caller UNAUTHORIZED", async () => {
    const caller = siteRouter.createCaller(contextFor("anonymous"));
    await expect(caller.getSite()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("answers a signed-in non-admin FORBIDDEN, before parsing the input", async () => {
    const caller = siteRouter.createCaller(contextFor("user"));
    await expect(caller.getSite()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.publishSite({ draftVersion: -1 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("site router", () => {
  it("saves, publishes and lists the site doc without the service's liveDoc", async () => {
    const { caller, kv } = setup();
    const state = await caller.getSite();
    expect(state.ok).toBe(true);
    expect(Object.keys(state).sort()).toEqual(
      ["changes", "doc", "draftVersion", "liveRevId", "ok"].sort()
    );
    const doc = state.ok ? state.doc : null;

    const saved = await caller.saveSiteDraft({ draftVersion: 0, doc });
    expect(saved).toMatchObject({ ok: true, draftVersion: 1, liveRevId: null });
    expect("liveDoc" in saved).toBe(false);

    expect(await caller.publishSite({ draftVersion: 1 })).toMatchObject({
      ok: true,
      live: true,
    });
    expect(JSON.parse((await kv.get("site"))!).doc).toBeTruthy();

    const history = await caller.siteHistory({});
    expect(history.ok && history.revisions[0]).toMatchObject({
      kind: "published",
      byYou: true,
      isLive: true,
    });
    expect(history.ok && history.nextCursor).toBeNull();

    expect(await caller.getSiteSwatches()).toMatchObject({
      ok: true,
      swatches: expect.any(Array),
    });
  });

  it("returns a stale draft as a result and checks the version name first", async () => {
    const { caller } = setup();
    expect(await caller.publishSite({ draftVersion: 3 })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    await expect(
      caller.saveSiteVersion({ draftVersion: 0, label: "x".repeat(81) })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { issues: [{ message: "A version name needs 1–80 characters" }] },
    });
  });
});
