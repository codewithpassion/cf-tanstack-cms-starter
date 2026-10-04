// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.
import type {
  BudgetLine,
  BudgetOverride,
  BudgetStatus,
} from "@repo/cms-core/agent/budget-types";
import { formatUsd } from "@repo/cms-core/agent/cost";
import { DEFAULT_RUN_CAP_USD } from "@repo/cms-core/agent/limits";
import {
  type AgentStore,
  type BudgetSettings,
  DEFAULT_BUDGET_SETTINGS,
} from "./store-port";

/** IANA zone whose midnight starts the daily cap (D14: the site's `timeZone`, default UTC). */
export const DEFAULT_BUDGET_TIME_ZONE = "UTC";

/**
 * The agent's spending caps as soft limits (docs/cms-plan.md §4.2): a per-thread cap, a per-run
 * cap for site-wide runs (each run item has its own thread, so the thread cap applies per item and
 * the run cap across the run), and a daily cap (a day in the site time zone), each raised by overrides the admin
 * adds from the AI tab ("+$5", "No limit for this thread", "+$20 today"…). Pure and client-safe:
 * the server computes the status before every model call, the AI tab shows it.
 */

export function effectiveCap(
  base: number | null,
  overrides: readonly Pick<BudgetOverride, "amountUsd">[]
): number | null {
  if (base === null || overrides.some((o) => o.amountUsd === null)) {
    return null;
  }
  return round6(base + overrides.reduce((s, o) => s + (o.amountUsd ?? 0), 0));
}

function line(
  base: number | null,
  spentUsd: number,
  overrides: BudgetOverride[]
): BudgetLine {
  const capUsd = effectiveCap(base, overrides);
  return {
    capUsd,
    spentUsd,
    remainingUsd:
      capUsd === null ? null : Math.max(0, round6(capUsd - spentUsd)),
    overrides,
  };
}

export function budgetStatus(input: {
  settings: BudgetSettings;
  threadId?: string | null;
  /** Null when there is no thread yet. */
  threadSpentUsd: number | null;
  /** A run item's turn: the run and its spend so far. */
  run?: { id: string; spentUsd: number } | null;
  daySpentUsd: number;
  day: string;
  overrides: BudgetOverride[];
}): BudgetStatus {
  const threadOverrides = input.overrides.filter((o) => o.scope === "thread");
  const runOverrides = input.overrides.filter(
    (o) => o.scope === "run" && o.threadId === input.run?.id
  );
  const dayOverrides = input.overrides.filter(
    (o) => o.scope === "day" && o.day === input.day
  );
  const thread =
    input.threadSpentUsd === null
      ? null
      : line(
          input.settings.threadCapUsd,
          input.threadSpentUsd,
          threadOverrides
        );
  const run = input.run
    ? {
        ...line(DEFAULT_RUN_CAP_USD, input.run.spentUsd, runOverrides),
        runId: input.run.id,
      }
    : null;
  const day = {
    ...line(input.settings.dailyCapUsd, input.daySpentUsd, dayOverrides),
    day: input.day,
  };
  const over = (l: BudgetLine | null) =>
    !!l && l.capUsd !== null && l.spentUsd >= l.capUsd;
  return {
    threadId: input.threadId ?? null,
    thread,
    run,
    day,
    blocked: over(thread)
      ? "thread"
      : over(run)
        ? "run"
        : over(day)
          ? "day"
          : null,
  };
}

/** The date in `timeZone`, as YYYY-MM-DD. */
export function budgetDay(
  now: number,
  timeZone = DEFAULT_BUDGET_TIME_ZONE
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
  }).format(new Date(now));
}

/** Milliseconds `zone` is ahead of UTC at `at`. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value])
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/** When the day (in `timeZone`) containing `now` started (UTC ms), for summing today's spend. */
export function budgetDayStart(
  now: number,
  timeZone = DEFAULT_BUDGET_TIME_ZONE
): number {
  const [y, m, d] = budgetDay(now, timeZone).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const midnight = Date.UTC(y, m - 1, d);
  // The offset at midnight can differ from now's on a daylight-saving day: correct once.
  const guess = midnight - zoneOffset(now, timeZone);
  return midnight - zoneOffset(guess, timeZone);
}

/**
 * The status from storage: settings (or the defaults), today's and the thread's spend, and the
 * overrides. `run`: in a run item's turn, the run and its spend so far (the run cap applies too).
 */
export async function loadBudget(
  store: Pick<
    AgentStore,
    "getSettings" | "threadCost" | "spentSince" | "overrides"
  >,
  threadId: string | null,
  now: number,
  run?: { id: string; spentUsd: number } | null,
  timeZone = DEFAULT_BUDGET_TIME_ZONE
): Promise<BudgetStatus> {
  const day = budgetDay(now, timeZone);
  const [settings, threadSpentUsd, daySpentUsd, overrides] = await Promise.all([
    store.getSettings(),
    threadId ? store.threadCost(threadId) : Promise.resolve(null),
    store.spentSince(new Date(budgetDayStart(now, timeZone))),
    store.overrides(threadId, day, run?.id ?? null),
  ]);
  return budgetStatus({
    settings: settings ?? DEFAULT_BUDGET_SETTINGS,
    threadId,
    threadSpentUsd,
    run: run ?? null,
    daySpentUsd,
    day,
    overrides,
  });
}

/** Why the agent paused, in a sentence. */
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

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
