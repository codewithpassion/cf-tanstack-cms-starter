import type { D1Db } from "@repo/db";
import { createD1AgentStore } from "@repo/db/agent-store";
import type { AgentStore } from "./store-port";

/** Type-level check, never run: the D1 store must satisfy the port the agent takes. */
declare const db: D1Db;

export const agentStore: AgentStore = createD1AgentStore(db);
