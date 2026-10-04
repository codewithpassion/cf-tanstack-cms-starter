import { expect, test } from "bun:test";
import { systemClock } from "./clock.ts";

test("systemClock returns the current time", () => {
  const before = Date.now();
  const now = systemClock().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});
