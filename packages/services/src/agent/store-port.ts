// biome-ignore-all lint/performance/noBarrelFile: one import path for the agent store's port and row types.
import type { AgentStoreTable } from "@repo/db/agent-store";

/**
 * Storage the agent needs, the `AgentStore` port (D7): threads with their turn lock, the
 * append-only transcript, staged changesets, spend outside the transcript, runs, and the spending
 * caps with their overrides. `createD1AgentStore` (`@repo/db/agent-store`) backs it with Drizzle on
 * D1 (`store-port.typecheck.ts` checks that it fits); `createMemoryAgentStore` (memory-store.ts)
 * backs it with arrays for tests.
 *
 * The method list is declared once, next to the D1 implementation (`AgentStoreTable`, a
 * structurally equal twin so `@repo/db` never imports services); the row types it speaks come
 * from the same place and are re-exported here, so services import one path.
 */
export type AgentStore = AgentStoreTable;

export {
  type BudgetSettings,
  type ChangesetRow,
  DEFAULT_BUDGET_SETTINGS,
  type LockResult,
  type PendingChangeset,
  type StoredMessage,
  type ThreadRow,
  threadModel,
  toChangeset,
  type UsageRow,
} from "@repo/db/agent-store";
