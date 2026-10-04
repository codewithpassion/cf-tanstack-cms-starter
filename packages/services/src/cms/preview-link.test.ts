// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import { signPreviewLink } from "./preview-link";
import { AGENT_PREVIEW_TTL_SECONDS, verifyRenderToken } from "./render-token";

const SECRET = "s".repeat(64);
const NOW = Date.UTC(2026, 9, 3, 1, 0, 0);

describe("signPreviewLink", () => {
  it("links to the page's public path with a token bound to the page (and changeset), expiring after the TTL", async () => {
    const link = await signPreviewLink(
      { signingKey: SECRET },
      { id: "p1", slug: "blog/a-post", status: "draft" },
      { ttlSeconds: AGENT_PREVIEW_TTL_SECONDS, changesetId: "cs1", now: NOW }
    );
    expect(link.path).toMatch(/^\/blog\/a-post\?_preview=/);
    expect(link.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
    const token = decodeURIComponent(link.path.split("_preview=")[1]!);
    const res = await verifyRenderToken(
      { signingKey: SECRET },
      token,
      { slug: "blog/a-post", purpose: "preview" },
      NOW
    );
    expect(res).toMatchObject({
      ok: true,
      claims: { pageId: "p1", changesetId: "cs1" },
    });
  });

  it("refuses archived pages", async () => {
    await expect(
      signPreviewLink(
        { signingKey: SECRET },
        { id: "p1", slug: "a", status: "archived" },
        { ttlSeconds: 60 }
      )
    ).rejects.toMatchObject({ code: "ARCHIVED" });
  });
});
