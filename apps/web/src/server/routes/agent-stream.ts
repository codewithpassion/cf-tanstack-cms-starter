import type { AgentEvent } from "@repo/cms-core/agent/types";
import type { BeginTurnResult, Turn } from "@repo/services/agent/turn";
import { readBody } from "./media-upload";

/**
 * The agent route's transport (routes/admin.api.agent.ts). `POST /admin/api/agent` runs one turn
 * and streams its `AgentEvent`s as server-sent events; `DELETE /admin/api/agent?threadId=…` is
 * Stop. The turn itself (validation, caps, the thread lock, the model loop, Stop polling and lock
 * renewal) is the services' `beginTurn`/`execute`/`stopTurn`; this module only checks the origin
 * and the admin before reading the body, sends refusals as JSON, and streams: one `data:` line per
 * event, a `: ping` comment every 15 s, the turn kept alive with `waitUntil` after the client
 * leaves, and `detached()` true once a write to the client fails. The route injects the admin
 * check, the turn and `waitUntil`, so nothing here touches `cloudflare:workers`.
 */

export type AgentAdmin = { userId: string; email: string };

type AdminCheck = {
  /** Resolves to the admin, or throws a `Response` (401/403/503) that is returned as is. */
  assertAdmin: (request: Request) => Promise<AgentAdmin>;
};

export type AgentTurnDeps = AdminCheck & {
  /** The services' `beginTurn` over this request's runtime, for this admin. */
  beginTurn: (admin: AgentAdmin, body: unknown) => Promise<BeginTurnResult>;
  /** Keeps the turn running after the response (the Worker's `waitUntil`). */
  waitUntil: (promise: Promise<unknown>) => void;
  log?: { error: (message: string, err?: unknown) => void };
  /** Ping interval; tests shorten it. */
  pingMs?: number;
};

export type AgentStopDeps = AdminCheck & {
  /** The services' `stopTurn` over the agent store. */
  stop: (threadId: string) => Promise<{ ok: true; stopping: boolean }>;
};

export const PING_MS = 15_000;
/** Largest JSON body accepted (the message itself is capped at 8000 characters by the schema). */
export const MAX_BODY = 64 * 1024;
const MAX_THREAD_ID = 64;

const error = (status: number, message: string) =>
  Response.json({ ok: false, message }, { status });

/**
 * Same-origin check: `Sec-Fetch-Site` must be `same-origin`; browsers that don't send it must send
 * an `Origin` equal to this request's origin.
 */
const isSameOrigin = (request: Request): boolean => {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) {
    return site === "same-origin";
  }
  return request.headers.get("Origin") === new URL(request.url).origin;
};

/** Origin, then admin; a Response is the early answer. The body is not touched. */
const admin = async (
  request: Request,
  deps: AdminCheck
): Promise<AgentAdmin | Response> => {
  if (!isSameOrigin(request)) {
    return error(403, "Cross-origin requests are not allowed.");
  }
  try {
    return await deps.assertAdmin(request);
  } catch (res) {
    if (res instanceof Response) {
      return res;
    }
    throw res;
  }
};

/** One SSE frame for an event: `data: <json>` and a blank line. */
export const sseFrame = (event: AgentEvent): string =>
  `data: ${JSON.stringify(event)}\n\n`;

/** An SSE comment line; clients skip it. Keeps proxies from closing an idle stream. */
export const SSE_PING = ": ping\n\n";

/** Streams a started turn as SSE. The turn runs under `waitUntil`, so it ends even if the client leaves. */
export const streamTurn = (
  turn: Turn,
  deps: Pick<AgentTurnDeps, "waitUntil" | "log" | "pingMs">
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  let detached = false;
  const write = (chunk: string) => {
    if (!open) {
      return;
    }
    writer.write(encoder.encode(chunk)).catch(() => {
      // The client went away: the current model call finishes and is stored, then the turn ends.
      open = false;
      detached = true;
    });
  };
  const emit = (event: AgentEvent) => write(sseFrame(event));

  const run = async () => {
    const ping = setInterval(() => write(SSE_PING), deps.pingMs ?? PING_MS);
    try {
      await turn.execute({ emit, detached: () => detached });
    } catch (err) {
      // `execute` reports model errors as events; anything else is a bug or an outage.
      deps.log?.error("agent: the turn failed", err);
      emit({ type: "error", message: "The turn failed unexpectedly." });
      emit({ type: "done", stopReason: "error" });
    } finally {
      clearInterval(ping);
      open = false;
      await writer.close().catch(() => undefined);
    }
  };
  deps.waitUntil(run());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
};

/** POST: origin and admin checks, then the JSON body, then `beginTurn`; a refusal is JSON with its status. */
export const handleAgentTurn = async (
  request: Request,
  deps: AgentTurnDeps
): Promise<Response> => {
  const who = await admin(request, deps);
  if (who instanceof Response) {
    return who;
  }
  // Check the declared length first, then count bytes while reading, so an oversize body is never buffered.
  const declared = Number(request.headers.get("Content-Length"));
  let bytes: Uint8Array | null = null;
  if (!(declared > MAX_BODY)) {
    bytes = request.body
      ? await readBody(request.body, MAX_BODY)
      : new Uint8Array();
  }
  if (!bytes) {
    return error(413, "The message is too long.");
  }
  const text = new TextDecoder().decode(bytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error(400, "Expected a JSON body.");
  }
  const turn = await deps.beginTurn(who, body);
  if (!turn.ok) {
    return Response.json(turn.body, { status: turn.status });
  }
  return streamTurn(turn, deps);
};

/** DELETE `?threadId=`: asks the thread's running turn to stop. `{ ok: true, stopping }`. */
export const handleAgentStop = async (
  request: Request,
  deps: AgentStopDeps
): Promise<Response> => {
  const who = await admin(request, deps);
  if (who instanceof Response) {
    return who;
  }
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId || threadId.length > MAX_THREAD_ID) {
    return error(400, "Expected ?threadId=.");
  }
  return Response.json(await deps.stop(threadId));
};
