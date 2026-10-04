import { describe, expect, it } from "bun:test";
import { fmtInt } from "./format";

describe("gsc format", () => {
  it("groups thousands with commas", () => {
    expect(fmtInt(1_234_567)).toBe("1,234,567");
  });
});
