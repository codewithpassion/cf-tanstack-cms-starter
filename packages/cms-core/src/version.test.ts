import { expect, test } from "bun:test";
import { CMS_CORE_VERSION } from "./version.ts";

test("exposes a positive integer version", () => {
  expect(Number.isInteger(CMS_CORE_VERSION)).toBe(true);
  expect(CMS_CORE_VERSION).toBeGreaterThan(0);
});
