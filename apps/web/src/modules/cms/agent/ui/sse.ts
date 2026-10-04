// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (the stream is read chunk by chunk), as in the source.
// biome-ignore-all lint/suspicious/noAssignInExpressions: the SSE frame loop assigns and tests the cut index in one condition, as in the source.
import type { AgentEvent } from "@repo/cms-core/agent/types";

/** Reads an SSE body: `data: <json>` events separated by blank lines; `:` comment lines are pings. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) {
        onEvent(JSON.parse(data) as AgentEvent);
      }
    }
    if (done) {
      return;
    }
  }
}
