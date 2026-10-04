import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@repo/cms-core/agent/types";
import { SSE_PING, sseFrame } from "#/server/routes/agent-stream";
import { readEvents } from "./sse";

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) {
        c.enqueue(enc.encode(ch));
      }
      c.close();
    },
  });
};

describe("readEvents", () => {
  it("reads data lines split across chunks and skips pings", async () => {
    const got: AgentEvent[] = [];
    await readEvents(
      streamOf([
        'data: {"type":"text","te',
        'xt":"Hi"}\n\n: ping\n\ndata: {"type":"done","stopReason":"end_turn"}\n\n',
      ]),
      (e) => got.push(e)
    );
    expect(got).toEqual([
      { type: "text", text: "Hi" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("reads the frames the agent route writes", async () => {
    const events: AgentEvent[] = [
      { type: "call_start" },
      { type: "text", text: "line one\nline two" },
      { type: "done", stopReason: "end_turn" },
    ];
    const [first, ...rest] = events.map(sseFrame);
    const got: AgentEvent[] = [];
    await readEvents(streamOf([first ?? "", SSE_PING, ...rest]), (e) =>
      got.push(e)
    );
    expect(got).toEqual(events);
  });
});
