import { describe, expect, it } from "bun:test";

import { handleMcpRequest, MAX_REQUEST_BYTES } from "./handler";
import { createTestEnv, TEST_ORIGIN } from "./test-env";

const initialize = (headers: Record<string, string>) =>
  new Request(`${TEST_ORIGIN}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    method: "POST",
  });

describe("handleMcpRequest", () => {
  it("takes a bearer key only: a session cookie without one is 401", async () => {
    const { env } = createTestEnv();
    const cases: Record<string, string>[] = [
      {},
      { Cookie: "__session=eyJhbGciOi.x.y; __client_uat=1" },
      { Authorization: "Bearer cms_dev_short" },
    ];
    for (const headers of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps failures readable.
      const res = await handleMcpRequest(env, initialize(headers));
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
  });

  it("refuses a body over 15 MB with 413, by Content-Length or by reading it", async () => {
    const { env, services } = createTestEnv();
    const { key } = await services.apiKeys.create({
      name: "laptop",
      scope: "read",
      createdBy: null,
      env: "dev",
    });
    const auth = { Authorization: `Bearer ${key}` };
    // Declared too large: refused before the key is even looked up.
    const declared = initialize({
      "Content-Length": String(MAX_REQUEST_BYTES + 1),
    });
    expect(declared.headers.get("Content-Length")).toBe(
      String(MAX_REQUEST_BYTES + 1)
    );
    expect((await handleMcpRequest(env, declared)).status).toBe(413);
    // Streamed without a Content-Length.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 1;
        if (sent > 16) {
          c.close();
        } else {
          c.enqueue(chunk);
        }
      },
    });
    const streamed = new Request(`${TEST_ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...auth,
      },
      body: big,
    });
    expect(streamed.headers.has("Content-Length")).toBe(false);
    expect((await handleMcpRequest(env, streamed)).status).toBe(413);
    // A small streamed body is buffered and handed on.
    const small = initialize(auth);
    const body = await small.text();
    const ok = new Request(small.url, {
      method: "POST",
      headers: small.headers,
      body: new Blob([body]).stream(),
    });
    expect(ok.headers.has("Content-Length")).toBe(false);
    expect((await handleMcpRequest(env, ok)).status).toBe(200);
  });
});
