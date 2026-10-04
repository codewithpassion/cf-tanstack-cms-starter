import { describe, expect, test } from "bun:test";
import { TEST_CONFIG } from "@repo/cms-core/test-fixtures";
import { mediaKey } from "@repo/services/cms/media-bytes";
import { bytes } from "@repo/services/testing/media-fixtures";
import { createMemoryBlobs } from "../mcp/test-env";
import {
  describeWithClaude,
  readMediaBytes,
  type VisionClient,
} from "./alt-text";
import { hydrator, IMAGE_UNAVAILABLE, refKey, toBase64 } from "./anthropic";
import {
  agentRenderUrl,
  CONTEXT_PX,
  MAX_HEIGHT,
  screenshotClip,
} from "./browser-render";
import { providerAvailability, providerFactories } from "./models";
import { workersAiBinding } from "./workers-ai";

const PNG_ID = `${"a".repeat(64)}.png`;

describe("hydrator", () => {
  test("turns media and r2 refs into base64 image blocks, nested in tool results", async () => {
    const { blobs } = createMemoryBlobs();
    const png = bytes("png");
    await blobs.put(mediaKey(PNG_ID), png, {
      httpMetadata: { contentType: "image/png" },
    });
    await blobs.put("agent/screens/t1/s.jpg", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const hydrate = hydrator(blobs);
    const out = await hydrate([
      { type: "text", text: "hi" },
      {
        type: "image",
        source: {
          type: "ref",
          ref: `media:${PNG_ID}`,
          media_type: "image/png",
        },
      },
      {
        type: "tool_result",
        tool_use_id: "x",
        content: [
          {
            type: "image",
            source: {
              type: "ref",
              ref: "r2:agent/screens/t1/s.jpg",
              media_type: "image/jpeg",
            },
          },
        ],
      },
    ]);
    expect(out).toEqual([
      { type: "text", text: "hi" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: toBase64(png),
        },
      },
      {
        type: "tool_result",
        tool_use_id: "x",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "AQID" },
          },
        ],
      },
    ]);
  });

  test("a missing or unsupported image becomes a note; plain strings pass through", async () => {
    const { blobs } = createMemoryBlobs();
    await blobs.put("agent/screens/x.svg", new Uint8Array([1]), {
      httpMetadata: { contentType: "image/svg+xml" },
    });
    const hydrate = hydrator(blobs);
    const ref = (r: string) => ({
      type: "image",
      source: { type: "ref", ref: r, media_type: "image/png" },
    });
    expect(
      await hydrate([
        ref("media:gone.png"),
        ref("r2:agent/screens/x.svg"),
        ref("nope"),
      ])
    ).toEqual([
      { type: "text", text: IMAGE_UNAVAILABLE },
      { type: "text", text: IMAGE_UNAVAILABLE },
      { type: "text", text: IMAGE_UNAVAILABLE },
    ]);
    expect(await hydrate("just text")).toBe("just text");
  });

  test("refKey maps the two ref kinds to R2 keys", () => {
    expect(refKey(`media:${PNG_ID}`)).toBe(mediaKey(PNG_ID));
    expect(refKey("r2:agent/screens/a.jpg")).toBe("agent/screens/a.jpg");
    expect(refKey("http://x")).toBeNull();
  });
});

describe("alt-text ports", () => {
  const fakeClient = (message: {
    stop_reason: string | null;
    content: { type: string; text?: string }[];
  }) => {
    const seen: unknown[] = [];
    const client: VisionClient = {
      beta: {
        messages: {
          create: (params) => {
            seen.push(params);
            return Promise.resolve({
              id: "msg_1",
              model: "claude-opus-5-5",
              usage: { input_tokens: 1000, output_tokens: 100 },
              ...message,
            });
          },
        },
      },
    };
    return { client, seen };
  };

  test("describe sends the image and prompt in one user turn and maps the answer", async () => {
    const { client, seen } = fakeClient({
      stop_reason: "end_turn",
      content: [
        { type: "thinking" },
        { type: "text", text: "A red" },
        { type: "text", text: "bicycle." },
      ],
    });
    const res = await describeWithClaude(client)({
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      prompt: "Write alt text",
    });
    expect(res).toMatchObject({
      id: "msg_1",
      model: "claude-opus-5-5",
      stop: "end",
      text: "A red bicycle.",
    });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AQID" },
            },
            { type: "text", text: "Write alt text" },
          ],
        },
      ],
    });
    expect(seen[0]).not.toHaveProperty("system");
  });

  test("describe maps refusal and other stops", async () => {
    const run = async (stop_reason: string | null) =>
      (
        await describeWithClaude(
          fakeClient({ stop_reason, content: [] }).client
        )({ mime: "image/png", bytes: new Uint8Array(), prompt: "p" })
      ).stop;
    expect(await run("refusal")).toBe("refusal");
    expect(await run("max_tokens")).toBe("other");
    expect(await run(null)).toBe("other");
  });

  test("readMediaBytes reads the media key, null when missing", async () => {
    const { blobs } = createMemoryBlobs();
    await blobs.put(mediaKey(PNG_ID), new Uint8Array([9]), {});
    const read = readMediaBytes(blobs);
    expect(await read(PNG_ID)).toEqual(new Uint8Array([9]));
    expect(await read(`${"b".repeat(64)}.png`)).toBeNull();
  });
});

describe("browser-render", () => {
  test("the whole page from the top, capped at MAX_HEIGHT", () => {
    expect(
      screenshotClip({ top: 0, bottom: 5000, height: 5000 }, 1440, false)
    ).toEqual({ x: 0, y: 0, width: 1440, height: MAX_HEIGHT });
    expect(
      screenshotClip({ top: 0, bottom: 600, height: 600 }, 390, false)
    ).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 600,
    });
  });

  test("a focused block with context, clamped to the page", () => {
    expect(
      screenshotClip({ top: 1000, bottom: 1400, height: 3000 }, 820, true)
    ).toEqual({
      x: 0,
      y: 1000 - CONTEXT_PX,
      width: 820,
      height: 400 + 2 * CONTEXT_PX,
    });
    expect(
      screenshotClip({ top: 50, bottom: 2950, height: 3000 }, 820, true)
    ).toEqual({
      x: 0,
      y: 0,
      width: 820,
      height: MAX_HEIGHT,
    });
    expect(
      screenshotClip({ top: 2900, bottom: 3000, height: 3000 }, 820, true)
    ).toEqual({
      x: 0,
      y: 2900 - CONTEXT_PX,
      width: 820,
      height: 100 + CONTEXT_PX,
    });
  });

  test("agentRenderUrl carries the token and the optional changeset", () => {
    expect(agentRenderUrl("https://example.com", "p/1", "tok", null)).toBe(
      "https://example.com/og-render-agent/p%2F1?t=tok"
    );
    expect(agentRenderUrl("https://example.com", "p1", "tok", "cs1")).toBe(
      "https://example.com/og-render-agent/p1?t=tok&cs=cs1"
    );
  });
});

describe("models", () => {
  const ai = { run: () => Promise.resolve({}) };

  test("availability follows the key and the binding", () => {
    expect(providerAvailability({})).toEqual({
      anthropic: false,
      workersAi: false,
    });
    expect(providerAvailability({ ANTHROPIC_API_KEY: "k", AI: ai })).toEqual({
      anthropic: true,
      workersAi: true,
    });
    expect(workersAiBinding({ AI: {} })).toBeNull();
  });

  test("factories build the providers, and refuse what isn't configured", () => {
    const hydrate = () => (c: unknown) => Promise.resolve(c as never);
    const none = providerFactories({}, TEST_CONFIG);
    expect(() => none.anthropic(hydrate)).toThrow("ANTHROPIC_API_KEY");
    expect(() => none.workersAi("@cf/x", hydrate)).toThrow("AI binding");
    const both = providerFactories(
      { ANTHROPIC_API_KEY: "k", AI: ai },
      TEST_CONFIG
    );
    expect(both.anthropic(hydrate).id).toBe("anthropic");
    expect(both.workersAi("@cf/x", hydrate)).toMatchObject({
      id: "workers-ai",
      model: "@cf/x",
    });
  });
});
