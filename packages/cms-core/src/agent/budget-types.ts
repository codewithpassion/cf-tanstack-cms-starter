import { DEFAULT_DAILY_CAP_USD, DEFAULT_THREAD_CAP_USD } from "./limits";

/** Budget shapes shared by the agent UI and the server (the budget arithmetic lives in services). Types only. */

/** A raised limit: `amountUsd` null = no limit (for that thread, or that day). */
export type BudgetOverride = {
  id: string;
  /** `run`: a site-wide run's cap; `threadId` then holds the run id. */
  scope: "thread" | "day" | "run";
  threadId: string | null;
  day: string | null;
  amountUsd: number | null;
  createdBy: string | null;
  createdAt: string;
};

export type BudgetLine = {
  /** The cap with overrides added; null = no limit. */
  capUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  overrides: BudgetOverride[];
};

export type BudgetStatus = {
  /** The thread `thread` counts (a run item's own thread during an item turn). */
  threadId: string | null;
  /** Null before the thread exists. */
  thread: BudgetLine | null;
  /** A site-wide run's spend (planning and every item) against the run cap; null outside a run item. */
  run: (BudgetLine & { runId: string }) | null;
  /** `day`: the Sydney date the daily cap is counting. */
  day: BudgetLine & { day: string };
  /** Which cap stops the next model call, if any (thread, then run, then day). */
  blocked: "thread" | "run" | "day" | null;
};

/** The default caps the admin changes under AI settings. Null = no cap. */
export type BudgetSettings = {
  threadCapUsd: number | null;
  dailyCapUsd: number | null;
};

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  threadCapUsd: DEFAULT_THREAD_CAP_USD,
  dailyCapUsd: DEFAULT_DAILY_CAP_USD,
};
