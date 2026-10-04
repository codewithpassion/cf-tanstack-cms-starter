/**
 * Every limit the AI agent enforces, in one place. The spending caps are
 * defaults: the admin changes them under AI settings (/admin/setup) and raises them per thread or
 * per day from the AI tab, so a cap never blocks for good. Client-safe (constants only).
 */

/** Default spend per conversation, in USD, before the agent pauses and asks. */
export const DEFAULT_THREAD_CAP_USD = 3;
/** Spend per site-wide run (planning and every item), in USD, before it pauses and asks. Raised per run from the AI tab. */
export const DEFAULT_RUN_CAP_USD = 15;
/** Default spend per day across all conversations, in USD. */
export const DEFAULT_DAILY_CAP_USD = 20;
/** The daily cap counts spend since midnight in this time zone ("today" in the AI tab). */
export const BUDGET_TIME_ZONE = "Australia/Sydney";
/** What the "raise" buttons add, in USD. */
export const THREAD_RAISE_STEPS_USD = [5, 20] as const;
export const DAY_RAISE_STEP_USD = 20;

/** One turn per thread at a time: the lock's lease, renewed while the turn runs. */
export const LOCK_LEASE_MS = 60_000;
export const LOCK_RENEW_MS = 20_000;
/** "Take over" may clear another tab's lock once it is this old. */
export const LOCK_TAKEOVER_AFTER_MS = 120_000;
/** How often a running turn checks for Stop (and for losing its lock). */
export const STOP_POLL_MS = 1500;

/** A thread past any of these takes no new messages ("Start a new thread"). */
export const MAX_THREAD_TURNS = 40;
export const MAX_THREAD_IMAGES = 60;
/** Input tokens of the latest request (the whole conversation as sent). */
export const MAX_THREAD_CONTEXT_TOKENS = 600_000;
