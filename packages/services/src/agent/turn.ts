// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/complexity/useOptionalChain: ported verbatim; explicit checks kept as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered tool calls, retries, D1 writes in order), as in the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: intentional no-op callbacks and ignored failures, as in the source.
// biome-ignore-all lint/suspicious/noReturnAssign: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.

import Anthropic from "@anthropic-ai/sdk";
import {
  LOCK_LEASE_MS,
  LOCK_RENEW_MS,
  LOCK_TAKEOVER_AFTER_MS,
  STOP_POLL_MS,
} from "@repo/cms-core/agent/limits";
import { DEFAULT_MODEL, type ModelRef } from "@repo/cms-core/agent/models";
import {
  contextMessage,
  decisionReport,
  itemContextMessage,
  planContextMessage,
  runReport,
} from "@repo/cms-core/agent/prompt";
import {
  finishItem,
  nextItem,
  type Run,
  RunError,
  type RunItem,
  startItem,
  threadOfItem,
} from "@repo/cms-core/agent/run";
import { plainTitle } from "@repo/cms-core/agent/thread-title";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import { mediaIdSchema } from "@repo/cms-core/media-schema";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ServiceDeps } from "../cms/pages-service";
import { budgetMessage, DEFAULT_BUDGET_TIME_ZONE, loadBudget } from "./budget";
import { runTurn } from "./loop";
import {
  modelOptions,
  type ProviderAvailability,
  unavailableReason,
} from "./models";
import type { ModelProvider } from "./provider";
import { endItem, itemMessage, mutateRun } from "./runs";
import { type AgentStore, threadModel, toChangeset } from "./store-port";
import { canContinue, threadFull } from "./thread-limits";
import { threadModelOff } from "./thread-view";
import type {
  ImageRef,
  StoredToolContent,
  ToolCtx,
  ToolDeps,
  ToolScope,
} from "./tools";

/**
 * One request to the agent route, after the admin and origin checks, as a service: `beginTurn`
 * validates the body, checks the spending caps and the thread's size, takes the thread's turn lock
 * (one turn per thread at a time) and builds the turn's input. It returns either a refusal (an
 * HTTP status and a JSON body) or a `Turn` whose `execute(io)` runs the turn, emitting
 * `AgentEvent`s through `io`. The web route is only the transport: it streams the events as SSE
 * under `waitUntil`, pings, and sets `io.detached` when a write to the client fails.
 *
 * Site-wide threads (`scope: "site"`): a message is a planning turn (read tools and `submit_plan`
 * only, high effort through a stored effort row); `runItem` runs one item of an approved run as a
 * turn scoped to that item's page, in the item's own transcript (an `item` thread, so the site
 * thread keeps only planning), then records how it ended on the run (`endItem`) with its spend. The
 * site thread's turn lock covers item turns too: one turn per run at a time, and Stop works the
 * same. Item turns are capped per item thread and per run.
 *
 * Ending a turn early:
 * - Stop (`stopTurn`, the route's DELETE) marks the thread; the turn polls it and aborts the model
 *   call in flight. Nothing of that call is stored, so the transcript stays valid.
 * - The tab going away (`io.detached()` turns true) lets the current model call finish and be
 *   stored, then the turn ends without running its tools or another call.
 */

export const turnBodySchema = z
  .strictObject({
    pageId: z.string().min(1).max(64),
    threadId: z.string().min(1).max(64).optional(),
    message: z.string().trim().min(1).max(8000).optional(),
    /** Continue a turn that paused on a spending cap (after raising it). */
    continue: z.literal(true).optional(),
    images: z.array(mediaIdSchema).max(4).optional(),
    /** A new thread's model (default: Claude). An existing thread keeps its own. */
    model: z
      .strictObject({
        provider: z.enum(["anthropic", "workers-ai"]),
        id: z.string().min(1).max(120),
      })
      .optional(),
    /** A new thread's scope: `site` plans and runs multi-page work (default: this page). */
    scope: z.enum(["page", "site"]).optional(),
    /** Run one item of an approved site-wide run (instead of a message). */
    runItem: z
      .strictObject({
        runId: z.string().min(1).max(80),
        itemId: z.string().min(1).max(80),
      })
      .optional(),
    context: z.strictObject({
      device: z.enum(["desktop", "tablet", "mobile"]),
      selectedKey: z.string().max(64).nullable(),
      draftVersion: z.number().int().min(0),
    }),
  })
  .refine(
    (b) =>
      [
        b.message !== undefined,
        b.continue === true,
        b.runItem !== undefined,
      ].filter(Boolean).length === 1,
    {
      message: "Send a message, continue a paused turn, or run a run item",
      path: ["message"],
    }
  )
  .refine((b) => !b.continue || (b.threadId && !b.images), {
    message: "Continuing needs the conversation and no images",
    path: ["continue"],
  })
  .refine((b) => !b.runItem || (b.threadId && !b.images), {
    message: "A run item needs its conversation and no images",
    path: ["runItem"],
  });

export type TurnLog = {
  error: (message: string, err?: unknown) => void;
  info: (message: string) => void;
};
const NO_LOG: TurnLog = { error: () => undefined, info: () => undefined };

export type TurnDeps = {
  store: AgentStore;
  /** The tool deps the turn runs with (pages, media, previews, ...): the adapter builds them per request. */
  tools: ToolDeps;
  /** The page service's deps: a run item's end rejects what it staged after a cancel. */
  cms: ServiceDeps;
  availability: ProviderAvailability;
  /** The provider for the thread's model (`providerFor` with the adapter's factories). */
  provider: (model: ModelRef) => ModelProvider;
  /** A media item of the library, for images dropped into the chat. */
  getMedia: (id: string) => Promise<{
    id: string;
    mime: string;
    width: number | null;
    height: number | null;
    alt: string | null;
  } | null>;
  /** The site's IANA zone for the daily cap, default "UTC" (D14). */
  timeZone?: string;
  now?: () => number;
  genId?: () => string;
  log?: TurnLog;
  /** How often a running turn checks for Stop and renews its lock (tests shorten it). */
  stopPollMs?: number;
};

/** What the route gives a turn: where events go and whether the client is still there. */
export type TurnIo = {
  emit: (event: AgentEvent) => void;
  /** True once the client has gone away (tab closed). */
  detached: () => boolean;
};

export type TurnRefusal = {
  ok: false;
  status: number;
  /** The JSON body: `{ ok: false, message, code?, ... }`. */
  body: { ok: false; message: string } & Record<string, unknown>;
};

export type Turn = {
  ok: true;
  threadId: string;
  /** Runs the turn to its end (always releases the lock) and emits `done` last. Never rejects on model errors. */
  execute: (io: TurnIo) => Promise<void>;
};

export type BeginTurnResult = Turn | TurnRefusal;

const refuse = (
  status: number,
  message: string,
  extra: Record<string, unknown> = {}
): TurnRefusal => ({
  ok: false,
  status,
  body: { ok: false, message, ...extra },
});

const SUPPORTED_IMAGES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export async function beginTurn(
  deps: TurnDeps,
  req: { body: unknown; userId: string }
): Promise<BeginTurnResult> {
  const parsed = turnBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return refuse(
      400,
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
    );
  }
  const input = parsed.data;

  const { store, tools } = deps;
  const clock = deps.now ?? Date.now;
  const genId = deps.genId ?? nanoid;
  const timeZone = deps.timeZone ?? DEFAULT_BUDGET_TIME_ZONE;
  const log = deps.log ?? NO_LOG;
  const page = await tools.pageById(input.pageId);
  if (!(page && page.draftDoc)) {
    return refuse(404, "Page not found.");
  }
  if (page.status === "archived") {
    return refuse(400, "Archived pages can't be edited.");
  }

  const thread = input.threadId ? await store.getThread(input.threadId) : null;
  // A site-wide conversation can be continued from any page's editor.
  if (
    input.threadId &&
    (!thread || (thread.scope !== "site" && thread.pageId !== page.id))
  ) {
    return refuse(404, "Conversation not found.");
  }
  const site = thread ? thread.scope === "site" : input.scope === "site";
  let run: Run | null = null;
  let item: RunItem | null = null;
  if (input.runItem) {
    if (!site) {
      return refuse(400, "Run items belong to site-wide conversations.");
    }
    run = await store.getRun(input.runItem.runId);
    item = run?.items.find((i) => i.id === input.runItem!.itemId) ?? null;
    if (!run || run.threadId !== thread!.id || !item) {
      return refuse(404, "Run item not found.");
    }
    if (run.status !== "active") {
      return refuse(409, `This run is ${run.status}.`, {
        code: "RUN_NOT_ACTIVE",
      });
    }
    if (item.status !== "pending" && item.status !== "running") {
      return refuse(409, `/${item.slug} is already ${item.status}.`, {
        code: "ITEM_DONE",
      });
    }
  }
  // A run item that paused (on a cap) runs again from the start; "continue" would answer it in planning scope.
  if (site && input.continue && thread) {
    const active = (
      await store.listRuns({ threadId: thread.id, limit: 5 })
    ).find((r) => r.status === "active" && nextItem(r, { threadBusy: false }));
    if (active) {
      return refuse(
        409,
        "This conversation has a run waiting: resume the run instead.",
        { code: "RUN_NOT_ACTIVE" }
      );
    }
  }
  const history = thread ? await store.messages(thread.id) : [];
  const changesets = thread ? await store.changesets(thread.id) : [];
  // The model: fixed per thread, and one of the enabled models in AI settings. A thread whose model
  // was turned off or removed takes no new messages (its transcript is in that model's format).
  const options = await modelOptions(deps.availability, store);
  let model: ModelRef;
  if (thread) {
    model = threadModel(thread);
    const off = threadModelOff(
      thread,
      history,
      changesets.map(toChangeset),
      options
    );
    if (off) {
      return refuse(409, off.message, { code: "MODEL_OFF", modelOff: off });
    }
  } else {
    model = input.model ?? DEFAULT_MODEL;
    const option = options.find(
      (m) => m.provider === model.provider && m.id === model.id
    );
    if (!option?.enabled) {
      return refuse(
        400,
        `${model.id} isn't one of the agent models enabled in AI settings.`
      );
    }
  }
  const unavailable = unavailableReason(deps.availability, model);
  if (unavailable) {
    return refuse(503, unavailable, { code: "MODEL_UNAVAILABLE" });
  }
  if (input.continue && !canContinue(history)) {
    return refuse(409, "There is no paused turn to continue.", {
      code: "NOTHING_TO_CONTINUE",
    });
  }
  // A run item's transcript: its own thread (created on its first attempt).
  const itemThread = run && item ? threadOfItem(run, item.id) : null;
  const itemThreadRow = itemThread ? await store.getThread(itemThread) : null;
  if (thread && !input.continue && !itemThread) {
    const full = threadFull(thread.title, history, changesets.map(toChangeset));
    if (full) {
      return refuse(409, full.message, { code: "THREAD_FULL", full });
    }
  }
  const itemFull = itemThreadRow
    ? threadFull(
        itemThreadRow.title,
        await store.messages(itemThreadRow.id),
        []
      )
    : null;
  const runSpend = (spentUsd: number) =>
    run ? { id: run.id, spentUsd } : null;
  const budget = await loadBudget(
    store,
    itemThread ?? thread?.id ?? null,
    clock(),
    runSpend(run?.costUsd ?? 0),
    timeZone
  );
  if (budget.blocked) {
    return refuse(402, budgetMessage(budget), { code: "BUDGET", budget });
  }

  // The turn lock: taken with the new thread, or on the existing one (refused while another tab runs a turn).
  const lockId = genId();
  const now = new Date(clock());
  let threadId: string;
  let title: string;
  if (thread) {
    const lock = await store.acquireLock(thread.id, lockId, now);
    if (!lock.ok) {
      const lockAgeMs = lock.lockAt ? now.getTime() - lock.lockAt.getTime() : 0;
      return refuse(
        409,
        "This conversation is busy in another tab or window.",
        {
          code: "BUSY",
          lockAgeMs,
          takeoverAfterMs: LOCK_TAKEOVER_AFTER_MS,
        }
      );
    }
    threadId = thread.id;
    title = thread.title;
  } else {
    threadId = genId();
    title = plainTitle(input.message!);
    await store.createThread({
      id: threadId,
      pageId: page.id,
      title,
      author: req.userId,
      createdAt: now,
      updatedAt: now,
      lockId,
      lockAt: now,
      lockExpiresAt: new Date(now.getTime() + LOCK_LEASE_MS),
      provider: model.provider,
      model: model.id,
      scope: site ? "site" : "page",
    });
  }

  let user: StoredToolContent | undefined;
  let context: string | undefined;
  let decisionsReportedAt: Date | undefined;
  let scope: ToolScope | undefined;
  let turnPageId: string | null = page.id;
  let effort: "high" | undefined;
  /** The transcript the turn writes to: the item's thread for a run item, else the conversation. */
  let transcriptId = threadId;
  let createdItemThread = false;
  try {
    if (site && input.runItem) {
      // One item of an approved run: a normal turn on the item's page (for create/duplicate, the draft once it exists).
      run = await mutateRun(
        store,
        run!.id,
        (r) => startItem(r, item!.id, now),
        now
      );
      item = run.items.find((i) => i.id === item!.id)!;
      if (itemFull) {
        throw new BadRequest(
          `This page's transcript is full (${itemFull.message.split(".")[0]!.toLowerCase()}). Skip it, or plan it again in a new run.`
        );
      }
      transcriptId = itemThread!;
      if (!itemThreadRow) {
        await store.createThread({
          id: transcriptId,
          pageId: page.id,
          title: `/${item.slug}: ${run.summary}`
            .replace(/\s+/g, " ")
            .slice(0, 80),
          author: req.userId,
          createdAt: now,
          updatedAt: now,
          provider: model.provider,
          model: model.id,
          scope: "item",
        });
        createdItemThread = true;
      }
      const target =
        item.action === "edit" || item.action === "seo"
          ? await tools.pageBySlug(item.slug)
          : item.createdPageId
            ? await tools.pageById(item.createdPageId)
            : null;
      const usable = target && target.status !== "archived" ? target : null;
      if ((item.action === "edit" || item.action === "seo") && !usable) {
        throw new BadRequest(`/${item.slug} is no longer a CMS page.`);
      }
      turnPageId = usable?.id ?? null;
      scope = { kind: "item", runId: run.id, item };
      user = [
        {
          type: "text",
          text: itemMessage(
            run,
            item,
            item.createdPageId && usable ? usable.slug : null
          ),
        },
      ];
      const n = run.items.findIndex((i) => i.id === item!.id) + 1;
      context = itemContextMessage(
        item,
        usable ? { title: usable.title, status: usable.status } : null,
        n,
        run.items.length
      );
    } else if (site) {
      // Planning: read tools and submit_plan only, at high effort.
      turnPageId = null;
      scope = { kind: "plan", provider: model.provider, model: model.id };
      effort = "high";
    }
    if (input.message !== undefined) {
      // Images dropped into the chat: library media, sent to the model as images.
      const images: ImageRef[] = [];
      const notes: string[] = [];
      for (const id of input.images ?? []) {
        const m = await deps.getMedia(id);
        if (!m) {
          throw new BadRequest(`Image ${id} isn't in the media library.`);
        }
        if (!SUPPORTED_IMAGES.has(m.mime)) {
          throw new BadRequest(
            "Only JPEG, PNG, GIF and WebP images can be sent to the agent."
          );
        }
        images.push({
          type: "image",
          source: { type: "ref", ref: `media:${m.id}`, media_type: m.mime },
        });
        notes.push(
          `${m.id} (${m.width ?? "?"}×${m.height ?? "?"}${m.alt ? `, alt: ${m.alt}` : ", no alt text yet"})`
        );
      }
      const text = notes.length
        ? `${input.message}\n\n[Attached images, now in the media library: ${notes.join("; ")}]`
        : input.message;
      // Decisions on earlier proposals not reported yet (including ones made while a turn ran), as data in the user's message.
      const reportedUntil = thread?.decisionsReportedAt?.getTime() ?? 0;
      const decided = changesets.filter(
        (c) => c.decidedAt && c.decidedAt.getTime() > reportedUntil
      );
      const report = decisionReport(decided.map(toChangeset));
      // Planning: how the conversation's runs went since (their items ran in their own transcripts).
      const ran =
        site && thread
          ? (await store.listRuns({ threadId: thread.id, limit: 5 })).filter(
              (r) => r.approvedAt && Date.parse(r.updatedAt) > reportedUntil
            )
          : [];
      const progress = runReport(ran);
      const seen = [
        ...decided.map((c) => c.decidedAt!.getTime()),
        ...ran.map((r) => Date.parse(r.updatedAt)),
      ];
      if (seen.length) {
        decisionsReportedAt = new Date(Math.max(...seen));
      }
      user = [
        ...images,
        { type: "text", text },
        ...(report ? [{ type: "text" as const, text: report }] : []),
        ...(progress ? [{ type: "text" as const, text: progress }] : []),
      ];
      context = site
        ? planContextMessage({ slug: page.slug, title: page.title })
        : contextMessage(
            {
              slug: page.slug,
              title: page.title,
              kind: page.kind,
              status: page.status,
            },
            { ...input.context }
          );
    }
  } catch (err) {
    if (run && item?.status === "running") {
      const failed =
        err instanceof BadRequest ? err.message : "The item couldn't start.";
      await mutateRun(store, run.id, (r) =>
        finishItem(
          r,
          item!.id,
          { stopReason: "error", changesetIds: [], costUsd: 0, error: failed },
          new Date()
        )
      ).catch(() => {});
    }
    if (createdItemThread) {
      await store.deleteThreadIfEmpty(transcriptId).catch(() => false);
    }
    await cleanup(store, threadId, lockId, !thread, log);
    if (err instanceof BadRequest) {
      return refuse(400, err.message);
    }
    if (err instanceof RunError) {
      return refuse(409, err.message, { code: "RUN_NOT_ACTIVE" });
    }
    throw err;
  }

  const provider = deps.provider(model);
  const exec = async (io: TurnIo) => {
    const abort = new AbortController();
    const emit = io.emit;
    // Stop and lock upkeep: abort the model call when Stop is requested or the lock was taken over.
    let lastRenew = clock();
    let polling = false;
    const poll = setInterval(() => {
      if (polling || abort.signal.aborted) {
        return;
      }
      polling = true;
      void (async () => {
        const t = await store.getThread(threadId);
        if (!t || t.lockId !== lockId || t.stopRequested === lockId) {
          return abort.abort();
        }
        if (clock() - lastRenew >= LOCK_RENEW_MS) {
          lastRenew = clock();
          if (!(await store.renewLock(threadId, lockId, new Date(clock())))) {
            abort.abort();
          }
        }
      })()
        .catch((err: unknown) => log.error("agent: stop poll failed", err))
        .finally(() => (polling = false));
    }, deps.stopPollMs ?? STOP_POLL_MS);
    emit({
      type: "thread",
      threadId,
      title,
      provider: model.provider,
      model: model.id,
    });
    emit({ type: "budget", budget });
    if (run) {
      emit({ type: "run", run });
    }
    let stopReason: string | null = "error";
    let failure: string | undefined;
    // Filled by the turn's tools; kept here so a turn that throws still reports what it staged and created.
    const produced: NonNullable<ToolCtx["produced"]> = {
      changesetIds: [],
      createdPageIds: [],
    };
    let pageIdAfter: string | null = turnPageId;
    const costBefore = site
      ? await store.threadCost(transcriptId).catch(() => 0)
      : 0;
    const runCostBefore = run?.costUsd ?? 0;
    const budgetNow = async () => {
      if (!run) {
        return loadBudget(store, transcriptId, clock(), null, timeZone);
      }
      const spent = Math.max(
        0,
        (await store.threadCost(transcriptId)) - costBefore
      );
      return loadBudget(
        store,
        transcriptId,
        clock(),
        runSpend(runCostBefore + spent),
        timeZone
      );
    };
    try {
      const result = await runTurn(
        {
          provider,
          store,
          tools,
          emit,
          signal: abort.signal,
          detached: io.detached,
          budget: budgetNow,
        },
        {
          threadId: transcriptId,
          pageId: turnPageId,
          user,
          context,
          decisionsReportedAt,
          produced,
          ...(scope && { scope }),
          ...(effort && { effort }),
        }
      );
      stopReason = result.stopReason;
      pageIdAfter = result.ctx.pageId;
    } catch (err) {
      log.error("agent turn failed", err);
      failure = errorMessage(err);
      emit({ type: "error", message: failure });
    } finally {
      clearInterval(poll);
    }
    if (site) {
      // The turn's spend (planning or one item) is added to its run: the run's total.
      try {
        if (run && item) {
          const done = await endItem(
            { store, cms: deps.cms },
            {
              runId: run.id,
              itemId: item.id,
              threadId: transcriptId,
              costBefore,
              stopReason,
              produced,
              pageId: pageIdAfter,
              ...(failure && { error: failure }),
            }
          );
          emit({ type: "run", run: done });
        } else {
          const spent = Math.max(
            0,
            (await store.threadCost(threadId)) - costBefore
          );
          const planned = (await store.listRuns({ threadId, limit: 5 })).find(
            (r) =>
              r.status === "proposed" &&
              Date.parse(r.createdAt) >= now.getTime()
          );
          if (planned) {
            emit({
              type: "plan",
              run: await mutateRun(store, planned.id, (r) => ({
                ...r,
                costUsd: Math.round((r.costUsd + spent) * 1e6) / 1e6,
              })),
            });
          }
        }
      } catch (err) {
        log.error("agent: recording the run item failed", err);
      }
    }
    if (createdItemThread) {
      await store.deleteThreadIfEmpty(transcriptId).catch(() => false);
    }
    const gone = await cleanup(store, threadId, lockId, !thread, log);
    if (gone) {
      emit({ type: "thread_gone" });
    }
    emit({ type: "done", stopReason });
  };
  return { ok: true, threadId, execute: exec };
}

class BadRequest extends Error {}

/** Releases the lock; removes a new thread whose first turn stored nothing. True when the thread is gone. */
async function cleanup(
  store: AgentStore,
  threadId: string,
  lockId: string,
  isNew: boolean,
  log: TurnLog
): Promise<boolean> {
  try {
    await store.releaseLock(threadId, lockId);
    return isNew ? await store.deleteThreadIfEmpty(threadId) : false;
  } catch (err) {
    log.error("agent: releasing the turn failed", err);
    return false;
  }
}

/** Stop: asks the thread's running turn to abort its model call (the route's DELETE). */
export async function stopTurn(
  store: Pick<AgentStore, "requestStop">,
  threadId: string
): Promise<{ ok: true; stopping: boolean }> {
  return { ok: true, stopping: await store.requestStop(threadId) };
}

function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return "The model is rate-limited right now. Try again in a minute.";
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was refused.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The model request failed (${err.status ?? "network"}): ${err.message}`;
  }
  const text = err instanceof Error ? err.message : String(err);
  if (/needs to be run remotely/i.test(text)) {
    return "Workers AI isn't reachable from this dev server (remote bindings are off).";
  }
  return text;
}
