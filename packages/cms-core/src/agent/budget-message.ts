import type { BudgetStatus } from "./budget-types";
import { formatUsd } from "./cost";

/** Why the agent paused, in a sentence. Shared by the server (refusals) and the AI tab. */
export function budgetMessage(budget: BudgetStatus): string {
  if (budget.blocked === "thread" && budget.thread) {
    return `This conversation has used ${formatUsd(budget.thread.spentUsd)} of its ${formatUsd(budget.thread.capUsd ?? 0)} limit.`;
  }
  if (budget.blocked === "run" && budget.run) {
    return `This run has used ${formatUsd(budget.run.spentUsd)} of its ${formatUsd(budget.run.capUsd ?? 0)} limit.`;
  }
  if (budget.blocked === "day") {
    return `Today's AI spend is ${formatUsd(budget.day.spentUsd)} of the ${formatUsd(budget.day.capUsd ?? 0)} daily limit.`;
  }
  return "";
}
