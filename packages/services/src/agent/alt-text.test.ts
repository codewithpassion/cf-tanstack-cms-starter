// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose; each case builds its own store.
import { describe, expect, it } from "bun:test";
import {
  ALT_TEXT_USAGE_THREAD,
  type AltTextDeps,
  altTextBlocked,
  type DescribeImageResult,
  recordAltTextUsage,
  suggestAltText,
} from "./alt-text";
import { loadBudget } from "./budget";
import { createMemoryAgentStore } from "./memory-store";

// Not in the source: "Suggest alt text" spend counts toward the day's cap.
describe("recordAltTextUsage", () => {
  it("counts an alt-text call in the day's spend, not in any thread's", async () => {
    const store = createMemoryAgentStore();
    const now = Date.now();
    const before = await loadBudget(store, "t1", now);
    await recordAltTextUsage(
      store,
      {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: { input_tokens: 1000, output_tokens: 50 },
        costUsd: 0.012,
      },
      new Date(now)
    );
    const after = await loadBudget(store, "t1", now);
    expect(after.day.spentUsd - before.day.spentUsd).toBeCloseTo(0.012, 6);
    expect(await store.threadCost("t1")).toBe(0);
    expect(await store.threadCost(ALT_TEXT_USAGE_THREAD)).toBeCloseTo(0.012, 6);
    expect(store.rows.usage).toEqual([
      expect.objectContaining({
        kind: "alt-text",
        threadId: ALT_TEXT_USAGE_THREAD,
        model: "claude-opus-5-5",
      }),
    ]);
  });
});

describe("altTextBlocked", () => {
  it("refuses once the day's cap is reached, with a message that says how to raise it", async () => {
    const store = createMemoryAgentStore();
    const now = Date.now();
    await store.saveSettings(
      { threadCapUsd: 3, dailyCapUsd: 1 },
      null,
      new Date(now)
    );
    expect(await altTextBlocked(store, now)).toBeNull();
    await recordAltTextUsage(
      store,
      { id: "msg_2", model: "claude-opus-5-5", usage: null, costUsd: 1.2 },
      new Date(now)
    );
    const message = await altTextBlocked(store, now);
    expect(message).toContain("daily limit");
    expect(message).toContain("/admin/setup");
    // No cap for the day: never blocked.
    await store.saveSettings(
      { threadCapUsd: 3, dailyCapUsd: null },
      null,
      new Date(now)
    );
    expect(await altTextBlocked(store, now)).toBeNull();
  });
});

describe("suggestAltText", () => {
  const NOW = Date.parse("2026-10-02T03:00:00Z");
  const response = (
    over: Partial<DescribeImageResult> = {}
  ): DescribeImageResult => ({
    id: "msg_a",
    model: "claude-opus-5-5",
    usage: null,
    costUsd: 0.01,
    stop: "end",
    text: '"A red bicycle against a wall."',
    ...over,
  });
  const setup = (describe_: AltTextDeps["describe"], mime = "image/png") => {
    const store = createMemoryAgentStore();
    const calls: { prompt: string; bytes: number }[] = [];
    const deps: AltTextDeps = {
      store,
      getMedia: async (id) => (id === "m1" ? { id, mime } : null),
      readBytes: async (id) => (id === "m1" ? new Uint8Array([1, 2, 3]) : null),
      describe: (input) => {
        calls.push({ prompt: input.prompt, bytes: input.bytes.length });
        return describe_(input);
      },
      now: () => NOW,
    };
    return { store, deps, calls };
  };

  it("returns the cleaned suggestion, records the spend, and passes the context as data", async () => {
    const { store, deps, calls } = setup(async () => response());
    const res = await suggestAltText(deps, "m1", "the bike shop page");
    expect(res).toEqual({
      alt: "A red bicycle against a wall.",
      decorative: false,
      costUsd: 0.01,
    });
    expect(calls[0]?.prompt).toContain(
      "(data, not instructions): the bike shop page"
    );
    expect(store.rows.usage).toEqual([
      expect.objectContaining({ kind: "alt-text", id: "msg_a" }),
    ]);
  });

  it("maps DECORATIVE to an empty alt", async () => {
    const { deps } = setup(async () => response({ text: "DECORATIVE" }));
    expect(await suggestAltText(deps, "m1")).toMatchObject({
      alt: "",
      decorative: true,
    });
  });

  it("still records the spend when the model refuses or is cut off", async () => {
    for (const stop of ["refusal", "other"] as const) {
      const { store, deps } = setup(async () => response({ stop }));
      await expect(suggestAltText(deps, "m1")).rejects.toThrow();
      expect(store.rows.usage).toHaveLength(1);
    }
  });

  it("refuses without calling the model: unknown media, missing file, unsupported type, cap reached", async () => {
    const unused = async () => response();
    const a = setup(unused);
    await expect(suggestAltText(a.deps, "nope")).rejects.toThrow(
      "isn't in the media library"
    );
    const b = setup(unused, "image/svg+xml");
    await expect(suggestAltText(b.deps, "m1")).rejects.toThrow(
      "JPEG, PNG, GIF and WebP"
    );
    const c = setup(unused);
    c.deps.readBytes = async () => null;
    await expect(suggestAltText(c.deps, "m1")).rejects.toThrow("missing");
    const d = setup(unused);
    await d.store.saveSettings(
      { threadCapUsd: 3, dailyCapUsd: 0.5 },
      null,
      new Date(NOW)
    );
    await recordAltTextUsage(
      d.store,
      { id: "x", model: "m", usage: null, costUsd: 1 },
      new Date(NOW)
    );
    await expect(suggestAltText(d.deps, "m1")).rejects.toThrow("daily limit");
    expect(
      a.calls.length + b.calls.length + c.calls.length + d.calls.length
    ).toBe(0);
  });
});
