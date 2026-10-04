import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import type { BeginTurnResult, TurnIo } from "@repo/services/agent/turn";
import {
  type AgentTurnDeps,
  handleAgentStop,
  handleAgentTurn,
} from "./agent-stream";

const URL_ = "https://example.com/admin/api/agent";
const ADMIN = { userId: "user_1", email: "ada@example.com" };

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    body,
    headers: { "Sec-Fetch-Site": "same-origin", ...headers },
  });

/** Splits an SSE body into its frames: data events (parsed) and comment lines. */
const frames = (text: string) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) =>
      frame.startsWith("data: ")
        ? (JSON.parse(frame.slice("data: ".length)) as AgentEvent)
        : frame
    );

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const DONE: AgentEvent = { type: "done", stopReason: "end_turn" };

/** Deps whose turn runs `script`; `pending` holds what was handed to `waitUntil`. */
function deps(
  script: (io: TurnIo) => Promise<void> = (io) => {
    io.emit({ type: "text", text: "Hi" });
    io.emit(DONE);
    return Promise.resolve();
  },
  overrides: Partial<AgentTurnDeps> = {}
) {
  const pending: Promise<unknown>[] = [];
  const seen: { admin: unknown; body: unknown }[] = [];
  const value: AgentTurnDeps = {
    assertAdmin: () => Promise.resolve(ADMIN),
    beginTurn: (admin, body): Promise<BeginTurnResult> => {
      seen.push({ admin, body });
      return Promise.resolve({ ok: true, threadId: "t1", execute: script });
    },
    waitUntil: (p) => {
      pending.push(p);
    },
    ...overrides,
  };
  return { deps: value, pending, seen };
}

describe("POST /admin/api/agent", () => {
  it("streams each event as a data frame, ending with done", async () => {
    const { deps: d, pending, seen } = deps();
    const res = await handleAgentTurn(post('{"pageId":"p1"}'), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8"
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    const [text] = await Promise.all([res.text(), ...pending]);
    expect(text).toBe(
      'data: {"type":"text","text":"Hi"}\n\ndata: {"type":"done","stopReason":"end_turn"}\n\n'
    );
    expect(seen).toEqual([{ admin: ADMIN, body: { pageId: "p1" } }]);
  });

  it("pings with a comment line while the turn runs", async () => {
    const { deps: d, pending } = deps(
      async (io) => {
        await sleep(30);
        io.emit(DONE);
      },
      { pingMs: 5 }
    );
    const res = await handleAgentTurn(post("{}"), d);
    const [text] = await Promise.all([res.text(), ...pending]);
    const got = frames(text);
    expect(got).toContain(": ping");
    expect(got.at(-1)).toEqual(DONE);
  });

  it("passes a refusal through as JSON with its status", async () => {
    const { deps: d, pending } = deps(undefined, {
      beginTurn: () =>
        Promise.resolve({
          ok: false,
          status: 409,
          body: { ok: false, message: "Busy.", code: "BUSY", lockAgeMs: 5 },
        }),
    });
    const res = await handleAgentTurn(post("{}"), d);
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    expect(body).toEqual({
      ok: false,
      message: "Busy.",
      code: "BUSY",
      lockAgeMs: 5,
    });
    expect(pending).toEqual([]);
  });

  it("answers 400 for a body that isn't JSON and 413 for one too large", async () => {
    const { deps: d, seen } = deps();
    expect((await handleAgentTurn(post("{nope"), d)).status).toBe(400);
    expect(
      (await handleAgentTurn(post(`"${"x".repeat(70 * 1024)}"`), d)).status
    ).toBe(413);
    expect(seen).toEqual([]);
  });

  it("rejects a cross-origin request before the admin check", async () => {
    let checked = false;
    const { deps: d } = deps(undefined, {
      assertAdmin: () => {
        checked = true;
        return Promise.resolve(ADMIN);
      },
    });
    const res = await handleAgentTurn(
      post("{}", { "Sec-Fetch-Site": "cross-site" }),
      d
    );
    expect(res.status).toBe(403);
    expect(checked).toBe(false);
    const viaOrigin = new Request(URL_, {
      method: "POST",
      body: "{}",
      headers: { Origin: "https://evil.example" },
    });
    expect((await handleAgentTurn(viaOrigin, d)).status).toBe(403);
  });

  it("returns the admin check's Response without reading the body", async () => {
    let read = false;
    // highWaterMark 0: the stream pulls only when someone reads it.
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          read = true;
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const request = new Request(URL_, {
      method: "POST",
      body,
      headers: { Origin: "https://example.com" },
      duplex: "half",
    } as RequestInit);
    const { deps: d, seen } = deps(undefined, {
      assertAdmin: () => {
        throw Response.json({ ok: false }, { status: 401 });
      },
    });
    const res = await handleAgentTurn(request, d);
    expect(res.status).toBe(401);
    expect(read).toBe(false);
    expect(seen).toEqual([]);
  });

  it("marks the turn detached once the client goes away, and the turn still finishes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detachedAt: boolean[] = [];
    let finished = false;
    const { deps: d, pending } = deps(async (io) => {
      io.emit({ type: "text", text: "first" });
      await gate;
      io.emit({ type: "text", text: "after the client left" });
      await sleep(5);
      detachedAt.push(io.detached());
      io.emit(DONE);
      finished = true;
    });
    const res = await handleAgentTurn(post("{}"), d);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(
      'data: {"type":"text","text":"first"}\n\n'
    );
    await reader.cancel();
    release();
    await Promise.all(pending);
    expect(detachedAt).toEqual([true]);
    expect(finished).toBe(true);
  });

  it("reports a turn that throws as error then done, and closes the stream", async () => {
    const errors: string[] = [];
    const { deps: d, pending } = deps(
      () => Promise.reject(new Error("D1 is down")),
      { log: { error: (message) => errors.push(message) } }
    );
    const res = await handleAgentTurn(post("{}"), d);
    const [text] = await Promise.all([res.text(), ...pending]);
    expect(frames(text)).toEqual([
      { type: "error", message: "The turn failed unexpectedly." },
      { type: "done", stopReason: "error" },
    ]);
    expect(errors).toEqual(["agent: the turn failed"]);
  });
});

describe("DELETE /admin/api/agent", () => {
  const del = (query: string, headers: Record<string, string> = {}) =>
    new Request(`${URL_}${query}`, {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "same-origin", ...headers },
    });

  it("asks the thread to stop", async () => {
    const stopped: string[] = [];
    const res = await handleAgentStop(del("?threadId=t1"), {
      assertAdmin: () => Promise.resolve(ADMIN),
      stop: (threadId) => {
        stopped.push(threadId);
        return Promise.resolve({ ok: true, stopping: true });
      },
    });
    const body: unknown = await res.json();
    expect(body).toEqual({ ok: true, stopping: true });
    expect(stopped).toEqual(["t1"]);
  });

  it("checks origin and admin, then the thread id", async () => {
    const stop = () => Promise.resolve({ ok: true as const, stopping: false });
    const ok = { assertAdmin: () => Promise.resolve(ADMIN), stop };
    expect(
      (
        await handleAgentStop(
          del("?threadId=t1", { "Sec-Fetch-Site": "cross-site" }),
          ok
        )
      ).status
    ).toBe(403);
    expect(
      (
        await handleAgentStop(del("?threadId=t1"), {
          assertAdmin: () => {
            throw Response.json({ ok: false }, { status: 403 });
          },
          stop,
        })
      ).status
    ).toBe(403);
    expect((await handleAgentStop(del(""), ok)).status).toBe(400);
    expect(
      (await handleAgentStop(del(`?threadId=${"x".repeat(65)}`), ok)).status
    ).toBe(400);
  });
});
