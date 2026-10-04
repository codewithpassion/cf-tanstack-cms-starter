import {
  acceptRunChangesetInput,
  approveRunInput,
  rejectRunChangesetInput,
  revertRunInput,
  reviewRunItemInput,
  runIdInput,
  runItemInput,
  siteProposalsInput,
  threadRunsInput,
} from "@repo/services/agent/admin-service";
import { adminProcedure, router } from "../../init.ts";
import { type AgentApiLoader, agentApiFor } from "./agent-api.ts";

/**
 * Site-wide runs: /admin/agent's review queue and the AI tab's Site scope (source: run-fns.ts and
 * run-list-fn.ts). Admin is asserted before the input is parsed; the inputs are the services' own
 * schemas. Results are the service's result unions with objects where the source sent JSON text
 * (`run`, `runs`, `detail`, `changesets`). Run-state refusals ("already done") are `{ ok: false }`.
 */
export const createAgentRunsRouter = (api: AgentApiLoader) =>
  router({
    /** One run with its proposals, the pages it refers to and its thread: `{ detail }`. */
    getRun: adminProcedure
      .input(runIdInput)
      .query(async ({ ctx, input }) => (await api(ctx)).admin.getRun(input)),

    /** The site-wide conversation's runs: `{ runs }`. */
    threadRuns: adminProcedure
      .input(threadRunsInput)
      .query(async ({ ctx, input }) =>
        (await api(ctx)).admin.threadRuns(input)
      ),

    /** Approves the plan as edited in the checklist: `{ run, errors }` (`run` null when the plan has errors). */
    approveRun: adminProcedure
      .input(approveRunInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.approveRunPlan(input)
      ),

    discardRun: adminProcedure
      .input(runIdInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.discardRunPlan(input)
      ),

    cancelRun: adminProcedure
      .input(runIdInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.cancelRunNow(input)
      ),

    skipRunItem: adminProcedure
      .input(runItemInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.skipRunItem(input)
      ),

    retryRunItem: adminProcedure
      .input(runItemInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.retryRunItem(input)
      ),

    /** The review queue's per-page Accept / Reject. */
    reviewRunItem: adminProcedure
      .input(reviewRunItemInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.reviewItem(input)
      ),

    /** Accepts a run's proposal from the editor: `{ revId, editor, run }`. */
    acceptRunChangeset: adminProcedure
      .input(acceptRunChangesetInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.acceptRunProposal(input)
      ),

    rejectRunChangeset: adminProcedure
      .input(rejectRunChangesetInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.rejectRunProposal(input)
      ),

    /** What "Revert this run" would do, page by page: `{ actions }`. */
    revertPreview: adminProcedure
      .input(runIdInput)
      .query(async ({ ctx, input }) =>
        (await api(ctx)).admin.previewRevert(input)
      ),

    /** Reverts the ticked pages: `{ run, actions, applied, alreadyReverted }`. */
    revertRun: adminProcedure
      .input(revertRunInput)
      .mutation(async ({ ctx, input }) =>
        (await api(ctx)).admin.revertTheRun(input)
      ),

    /** Pending site-run proposals on this page (the editor's AI tab): `{ changesets }`. */
    siteProposals: adminProcedure
      .input(siteProposalsInput)
      .query(async ({ ctx, input }) =>
        (await api(ctx)).admin.siteProposals(input)
      ),

    /** Every run and the site-wide conversations (/admin/agent): `{ runs, threads }`. */
    listRuns: adminProcedure.query(async ({ ctx }) =>
      (await api(ctx)).admin.listRuns()
    ),
  });

export const agentRunsRouter = createAgentRunsRouter(agentApiFor);
