// biome-ignore-all lint/performance/noAwaitInLoops: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noBitwiseOperators: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import {
  MAX_TTL_SECONDS,
  OG_TOKEN_TTL_SECONDS,
  type RenderPurpose,
  RenderTokenConfigError,
  signRenderToken,
  verifyRenderToken,
} from "./render-token";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const og = { slug: "cms-test", purpose: "og" } as const;

const sign = (
  claims: { slug: string; purpose: RenderPurpose } = og,
  secret = SECRET,
  ttlSeconds = OG_TOKEN_TTL_SECONDS
) => signRenderToken({ signingKey: secret }, claims, { ttlSeconds, now: NOW });

/** Re-encodes `token`'s claims with `patch` applied, keeping the original signature. */
function withClaims(token: string, patch: Record<string, unknown>): string {
  const [payload, sig] = token.split(".");
  const json = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")));
  const forged = btoa(JSON.stringify({ ...json, ...patch }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/, "");
  return `${forged}.${sig}`;
}

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/, "");

/** Signs arbitrary claims with the real key, bypassing signRenderToken's checks (as a bug or a leaked key might). */
async function signRaw(claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}

describe("render tokens", () => {
  it("round-trips slug, purpose and expiry", async () => {
    const token = await sign();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const result = await verifyRenderToken(
      { signingKey: SECRET },
      token,
      og,
      NOW
    );
    expect(result).toEqual({
      ok: true,
      claims: { ...og, exp: NOW / 1000 + OG_TOKEN_TTL_SECONDS },
    });
  });

  it("carries the page id when given, and refuses a non-string one", async () => {
    const preview = { slug: "services/a", purpose: "preview" } as const;
    const token = await signRenderToken(
      { signingKey: SECRET },
      { ...preview, pageId: "page_a" },
      { ttlSeconds: 60, now: NOW }
    );
    expect(
      await verifyRenderToken({ signingKey: SECRET }, token, preview, NOW)
    ).toEqual({
      ok: true,
      claims: { ...preview, pageId: "page_a", exp: NOW / 1000 + 60 },
    });
    const bad = await signRaw({ ...preview, pageId: 42, exp: NOW / 1000 + 60 });
    expect(
      await verifyRenderToken({ signingKey: SECRET }, bad, preview, NOW)
    ).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("carries a changeset id when given, can't have one forged in, and refuses a non-string one", async () => {
    const preview = { slug: "services/a", purpose: "preview" } as const;
    const token = await signRenderToken(
      { signingKey: SECRET },
      { ...preview, pageId: "page_a", changesetId: "cs_1" },
      { ttlSeconds: 60, now: NOW }
    );
    expect(
      await verifyRenderToken({ signingKey: SECRET }, token, preview, NOW)
    ).toEqual({
      ok: true,
      claims: {
        ...preview,
        pageId: "page_a",
        changesetId: "cs_1",
        exp: NOW / 1000 + 60,
      },
    });
    const plain = await signRenderToken(
      { signingKey: SECRET },
      { ...preview, pageId: "page_a" },
      { ttlSeconds: 60, now: NOW }
    );
    expect(
      await verifyRenderToken(
        { signingKey: SECRET },
        withClaims(plain, { changesetId: "cs_2" }),
        preview,
        NOW
      )
    ).toEqual({ ok: false, reason: "bad-signature" });
    const bad = await signRaw({
      ...preview,
      pageId: "page_a",
      changesetId: 7,
      exp: NOW / 1000 + 60,
    });
    expect(
      await verifyRenderToken({ signingKey: SECRET }, bad, preview, NOW)
    ).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("works for the home page's empty slug", async () => {
    const home = { slug: "", purpose: "og" } as const;
    expect(
      (
        await verifyRenderToken(
          { signingKey: SECRET },
          await sign(home),
          home,
          NOW
        )
      ).ok
    ).toBe(true);
  });

  it("expires at exp", async () => {
    const token = await sign();
    const exp = NOW + OG_TOKEN_TTL_SECONDS * 1000;
    expect(
      (await verifyRenderToken({ signingKey: SECRET }, token, og, exp - 1)).ok
    ).toBe(true);
    expect(
      await verifyRenderToken({ signingKey: SECRET }, token, og, exp)
    ).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token signed with another secret", async () => {
    expect(
      await verifyRenderToken(
        { signingKey: SECRET },
        await sign(og, OTHER),
        og,
        NOW
      )
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects tampered claims (slug, purpose, expiry) before reading them", async () => {
    const token = await sign();
    for (const patch of [
      { slug: "about" },
      { purpose: "preview" },
      { exp: NOW / 1000 + 10 ** 9 },
    ]) {
      expect(
        await verifyRenderToken(
          { signingKey: SECRET },
          withClaims(token, patch),
          og,
          NOW
        )
      ).toEqual({ ok: false, reason: "bad-signature" });
    }
  });

  it("rejects a tampered signature", async () => {
    const token = await sign();
    const flipped =
      token.slice(0, -2) + (token.at(-2) === "A" ? "B" : "A") + token.at(-1);
    expect(
      await verifyRenderToken({ signingKey: SECRET }, flipped, og, NOW)
    ).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("accepts only the canonical spelling of the signature", async () => {
    const token = await sign();
    const last = B64URL.indexOf(token.at(-1)!);
    // The last of 43 characters holds 4 signature bits and 2 unused ones: these 3 spellings
    // decode to the same 32 bytes.
    const aliases = [0, 1, 2, 3]
      .map((low) => (last & ~3) | low)
      .filter((i) => i !== last);
    for (const i of aliases) {
      const alias = token.slice(0, -1) + B64URL[i];
      const sigOf = (t: string) =>
        atob(`${t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")}=`);
      expect(sigOf(alias)).toBe(sigOf(token));
      expect(
        await verifyRenderToken({ signingKey: SECRET }, alias, og, NOW)
      ).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    expect(
      (await verifyRenderToken({ signingKey: SECRET }, token, og, NOW)).ok
    ).toBe(true);
  });

  it("caps each purpose's lifetime when signing", async () => {
    await expect(
      sign(og, SECRET, MAX_TTL_SECONDS.og + 1)
    ).rejects.toBeInstanceOf(RangeError);
    await expect(sign(og, SECRET, 0)).rejects.toBeInstanceOf(RangeError);
    const preview = { slug: "cms-test", purpose: "preview" } as const;
    expect(
      (
        await verifyRenderToken(
          { signingKey: SECRET },
          await sign(preview, SECRET, 7 * 24 * 3600),
          preview,
          NOW
        )
      ).ok
    ).toBe(true);
    await expect(
      sign(preview, SECRET, 7 * 24 * 3600 + 1)
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects a validly signed token that outlives its purpose's cap", async () => {
    const nowSec = NOW / 1000;
    expect(MAX_TTL_SECONDS.og).toBe(600);
    expect(
      (
        await verifyRenderToken(
          { signingKey: SECRET },
          await signRaw({ ...og, exp: nowSec + 600 }),
          og,
          NOW
        )
      ).ok
    ).toBe(true);
    expect(
      await verifyRenderToken(
        { signingKey: SECRET },
        await signRaw({ ...og, exp: nowSec + 601 }),
        og,
        NOW
      )
    ).toEqual({ ok: false, reason: "ttl-too-long" });
    const preview = { slug: "cms-test", purpose: "preview" } as const;
    const week = 7 * 24 * 3600;
    expect(
      (
        await verifyRenderToken(
          { signingKey: SECRET },
          await signRaw({ ...preview, exp: nowSec + week }),
          preview,
          NOW
        )
      ).ok
    ).toBe(true);
    expect(
      await verifyRenderToken(
        { signingKey: SECRET },
        await signRaw({ ...preview, exp: nowSec + week + 1 }),
        preview,
        NOW
      )
    ).toEqual({
      ok: false,
      reason: "ttl-too-long",
    });
  });

  it("binds the purpose and the slug", async () => {
    const preview = await sign({ slug: "cms-test", purpose: "preview" });
    expect(
      await verifyRenderToken({ signingKey: SECRET }, preview, og, NOW)
    ).toEqual({
      ok: false,
      reason: "wrong-purpose",
    });
    expect(
      await verifyRenderToken(
        { signingKey: SECRET },
        await sign(),
        { slug: "about", purpose: "og" },
        NOW
      )
    ).toEqual({
      ok: false,
      reason: "wrong-slug",
    });
  });

  it("rejects missing and malformed tokens", async () => {
    expect(
      await verifyRenderToken({ signingKey: SECRET }, undefined, og, NOW)
    ).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      await verifyRenderToken({ signingKey: SECRET }, "", og, NOW)
    ).toEqual({
      ok: false,
      reason: "missing",
    });
    const token = await sign();
    for (const bad of [
      "abc",
      "a.b.c",
      `${token}.x`,
      `.${token.split(".")[1]}`,
      `${token.split(".")[0]}.`,
      "x".repeat(2000),
      `${token.split(".")[0]}.%%%`,
    ]) {
      expect(
        await verifyRenderToken({ signingKey: SECRET }, bad, og, NOW)
      ).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("rejects a correctly signed payload that isn't valid claims", async () => {
    expect(
      await verifyRenderToken(
        { signingKey: SECRET },
        await signRaw({ slug: "cms-test", purpose: "admin", exp: 9e9 }),
        og,
        NOW
      )
    ).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("fails closed without a usable secret", async () => {
    await expect(
      signRenderToken({ signingKey: undefined }, og, { ttlSeconds: 60 })
    ).rejects.toBeInstanceOf(RenderTokenConfigError);
    await expect(
      verifyRenderToken({ signingKey: "short" }, "x.y", og)
    ).rejects.toBeInstanceOf(RenderTokenConfigError);
  });
});
