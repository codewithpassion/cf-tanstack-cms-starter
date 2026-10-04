import { describe, expect, it } from "bun:test";
import { budgetMessage } from "./budget-message";
import type { BudgetStatus } from "./budget-types";

const base = {
  blocked: null,
  day: { spentUsd: 1.5, capUsd: 1, day: "2026-10-04" },
} as unknown as BudgetStatus;

describe("budgetMessage", () => {
  it("names the daily limit when the day is blocked", () => {
    expect(budgetMessage({ ...base, blocked: "day" })).toContain("daily limit");
  });

  it("is empty when nothing is blocked", () => {
    expect(budgetMessage(base)).toBe("");
  });
});
