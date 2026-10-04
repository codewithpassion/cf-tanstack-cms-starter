import { describe, expect, it } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { TRPCError } from "@trpc/server";

import { isSignedOutError, signedOutAsResult } from "./signed-out";

const clientError = (code: string) =>
  TRPCClientError.from({
    error: {
      code: -32_001,
      data: { code, httpStatus: code === "UNAUTHORIZED" ? 401 : 403 },
      message: code,
    },
  } as never);

describe("isSignedOutError", () => {
  it("recognises a tRPC UNAUTHORIZED (client link or caller) and a plain 401", () => {
    expect(isSignedOutError(clientError("UNAUTHORIZED"))).toBe(true);
    expect(isSignedOutError(new TRPCError({ code: "UNAUTHORIZED" }))).toBe(
      true
    );
    expect(isSignedOutError(new Response(null, { status: 401 }))).toBe(true);
  });

  it("leaves other failures alone, FORBIDDEN (signed in, not an admin) included", () => {
    expect(isSignedOutError(clientError("FORBIDDEN"))).toBe(false);
    expect(isSignedOutError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isSignedOutError(new Response(null, { status: 500 }))).toBe(false);
    expect(isSignedOutError(new Error("Sign in required."))).toBe(false);
  });
});

describe("signedOutAsResult", () => {
  it("maps a signed-out failure to SIGNED_OUT and rethrows anything else", async () => {
    await expect(
      signedOutAsResult(() => Promise.reject(clientError("UNAUTHORIZED")))
    ).resolves.toMatchObject({
      ok: false,
      code: "SIGNED_OUT",
    });
    await expect(
      signedOutAsResult(() => Promise.reject(new TypeError("Failed to fetch")))
    ).rejects.toThrow("Failed to fetch");
    await expect(
      signedOutAsResult(async () => ({ ok: true as const }))
    ).resolves.toEqual({ ok: true });
  });
});
