// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import { OpError } from "@repo/cms-core/ops/apply-ops";

import { adminResult, toAdminError } from "./admin-errors";
import { CmsError } from "./pages-service";

describe("toAdminError", () => {
  it("maps a stale draft", () => {
    expect(
      toAdminError(
        new CmsError(
          "STALE_DRAFT",
          "the draft changed since it was loaded; reload it",
          { current: 4 }
        )
      )
    ).toEqual({
      ok: false,
      code: "STALE_DRAFT",
      message: "the draft changed since it was loaded; reload it",
    });
  });

  it("reports the first validation error with its path", () => {
    const err = new CmsError("INVALID_DOC", "document failed validation", [
      { path: "blocks[2].props.heading", message: "Too small" },
      { path: "seo.title", message: "Required" },
    ]);
    expect(toAdminError(err)).toEqual({
      ok: false,
      code: "INVALID_DOC",
      message: "blocks[2].props.heading: Too small",
      path: "blocks[2].props.heading",
    });
  });

  it("points INVALID_OPS from applyOps at the op", () => {
    const err = new CmsError("INVALID_OPS", 'op 1: no block with key "x"', {
      opIndex: 1,
      code: "UNKNOWN_KEY",
    });
    expect(toAdminError(err)).toEqual({
      ok: false,
      code: "INVALID_OPS",
      message: 'op 1: no block with key "x"',
      path: "ops[1]",
    });
  });

  it("maps slug errors and a bare OpError", () => {
    expect(
      toAdminError(
        new CmsError(
          "SLUG_RESERVED",
          '"about" belongs to a page built into the site; pick another slug'
        )
      )
    ).toMatchObject({
      code: "SLUG_RESERVED",
    });
    expect(toAdminError(new OpError("BAD_POSITION", 0, "bad"))).toEqual({
      ok: false,
      code: "BAD_POSITION",
      message: "op 0: bad",
      path: "ops[0]",
    });
  });

  it("leaves anything else alone", () => {
    expect(toAdminError(new Error("D1 is down"))).toBeNull();
    expect(toAdminError("nope")).toBeNull();
  });
});

describe("adminResult", () => {
  it("wraps success", async () => {
    expect(await adminResult(async () => ({ id: "p1" }))).toEqual({
      ok: true,
      id: "p1",
    });
  });

  it("maps expected failures and rethrows the rest", async () => {
    expect(
      await adminResult(async () => {
        throw new CmsError("NOT_FOUND", "page x not found");
      })
    ).toEqual({ ok: false, code: "NOT_FOUND", message: "page x not found" });
    await expect(
      adminResult(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
