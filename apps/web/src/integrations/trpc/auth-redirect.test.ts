import { describe, expect, it } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { TRPCError } from "@trpc/server";
import {
  isUnauthorized,
  loginHref,
  redirectOnUnauthorized,
} from "./auth-redirect.ts";

const clientError = (code: string) =>
  TRPCClientError.from({
    error: {
      code: -32_001,
      data: { code, httpStatus: code === "UNAUTHORIZED" ? 401 : 403 },
      message: code,
    },
  } as never);

describe("isUnauthorized", () => {
  it("recognises UNAUTHORIZED from the client link and from a caller", () => {
    expect(isUnauthorized(clientError("UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorized(new TRPCError({ code: "UNAUTHORIZED" }))).toBe(true);
  });

  it("leaves FORBIDDEN and other errors alone", () => {
    expect(isUnauthorized(clientError("FORBIDDEN"))).toBe(false);
    expect(isUnauthorized(new Error("boom"))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});

describe("loginHref", () => {
  it("encodes the page to return to", () => {
    expect(loginHref("/admin/editor/a b?x=1")).toBe(
      "/login?redirect_url=%2Fadmin%2Feditor%2Fa%20b%3Fx%3D1"
    );
  });
});

describe("redirectOnUnauthorized", () => {
  it("passes results through", async () => {
    expect(await redirectOnUnauthorized(Promise.resolve(7), "/admin")).toBe(7);
  });

  it("throws a redirect to the login page on UNAUTHORIZED", async () => {
    const thrown = await redirectOnUnauthorized(
      Promise.reject(clientError("UNAUTHORIZED")),
      "/admin/pages"
    ).catch((error: unknown) => error);
    expect(thrown).toMatchObject({
      options: { href: "/login?redirect_url=%2Fadmin%2Fpages" },
    });
  });

  it("rethrows other errors", async () => {
    const error = clientError("FORBIDDEN");
    await expect(
      redirectOnUnauthorized(Promise.reject(error), "/admin")
    ).rejects.toBe(error);
  });
});
