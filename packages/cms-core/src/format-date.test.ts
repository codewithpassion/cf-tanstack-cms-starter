import { describe, expect, it } from "bun:test";

import { formatDateTime } from "./format-date";

describe("formatDateTime", () => {
  it("formats in Sydney time, the same everywhere", () => {
    // 23:30 UTC on 1 Oct = 09:30 on 2 Oct in Sydney (AEST, before daylight saving starts on 5 Oct 2026).
    expect(formatDateTime("2026-10-01T23:30:00Z")).toBe("2 Oct 2026, 09:30");
    // Daylight saving (AEDT, +11): 13:05 UTC = 00:05 the next day.
    expect(formatDateTime("2026-12-31T13:05:00Z")).toBe("1 Jan 2027, 00:05");
    expect(formatDateTime(new Date("2026-06-15T02:00:00Z"))).toBe(
      "15 Jun 2026, 12:00"
    );
    expect(formatDateTime("not a date")).toBe("");
  });
});
