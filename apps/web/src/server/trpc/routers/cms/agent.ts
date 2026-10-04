import {
  decideChangesetInput,
  getThreadInput,
  listThreadsInput,
  raiseBudgetInput,
  saveModelsInput,
  saveSettingsInput,
  suggestAltTextInput,
  takeOverInput,
} from "@repo/services/agent/admin-service";
import type { AltSuggestion } from "@repo/services/agent/alt-text";
import { adminProcedure, router } from "../../init.ts";
import { type AgentApiLoader, agentApiFor } from "./agent-api.ts";

/**
 * The editor's AI tab and the AI settings (source: agent-fns.ts). Admin is asserted before the
 * input is parsed; the inputs are the services' own schemas. Each procedure returns the service's
 * `adminResult` union (`{ ok: true, ... } | { ok: false, code, message }`), with objects where the
 * source sent JSON text (`detail`, not `detailJson`).
 */

/** Longest page context passed to the alt-text prompt, as in the source. */
const MAX_ALT_CONTEXT = 300;

export type SuggestAltTextResult =
  | ({ ok: true } & AltSuggestion)
  | { ok: false; message: string };

export const createAgentRouter = (api: AgentApiLoader) =>
  router({
    /** The page's threads (or the site-wide ones, `scope: "site"`) and the caps before a thread exists. */
    listAgentThreads: adminProcedure
      .input(listThreadsInput)
      .query(async ({ ctx, input }) =>
        (await api(ctx)).admin.listAgentThreads(input)
      ),

    /** One thread as the chat shows it: `{ detail }`. */
    getAgentThread: adminProcedure
      .input(getThreadInput)
      .query(async ({ ctx, input }) =>
        (await api(ctx)).admin.getAgentThread(input)
      ),

    /** Raises a thread's, a run's or today's cap by an offered step (null: no limit). */
    raiseAgentBudget: adminProcedure
      .input(raiseBudgetInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.raiseAgentBudget(input)
      ),

    /** "Take over": clears another tab's stale turn lock. */
    takeOverAgentThread: adminProcedure
      .input(takeOverInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.takeOverAgentThread(input)
      ),

    getAgentSettings: adminProcedure.query(async ({ ctx }) =>
      (await api(ctx)).admin.getAgentSettings()
    ),

    getAgentModels: adminProcedure.query(async ({ ctx }) =>
      (await api(ctx)).admin.getAgentModels()
    ),

    saveAgentModels: adminProcedure
      .input(saveModelsInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.saveAgentModels(input)
      ),

    saveAgentSettings: adminProcedure
      .input(saveSettingsInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.saveAgentSettings(input)
      ),

    /** Records the decision on a pending (page-thread) changeset; an accept needs the saved `draftVersion`. */
    decideChangeset: adminProcedure
      .input(decideChangesetInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.decideChangeset(input)
      ),

    /**
     * The media library's "Suggest alt text". The service throws plain errors for the expected
     * refusals (daily cap, not in the library, unsupported type, model unavailable); they come back
     * as `{ ok: false, message }`, because a thrown error would reach the client as a 500 with its
     * message hidden in production.
     */
    suggestAltText: adminProcedure
      .input(suggestAltTextInput)
      .mutation(async ({ ctx, input }): Promise<SuggestAltTextResult> => {
        const { suggestAltText } = await api(ctx);
        try {
          const suggestion = await suggestAltText(
            input.id,
            input.context?.slice(0, MAX_ALT_CONTEXT)
          );
          return { ok: true, ...suggestion };
        } catch (err) {
          if (err instanceof Error) {
            return { ok: false, message: err.message };
          }
          throw err;
        }
      }),
  });

export const agentRouter = createAgentRouter(agentApiFor);
