import { describe, expect, it } from "bun:test";

import {
  addUsage,
  costOf,
  formatUsd,
  summarizeUsage,
  ZERO_USAGE,
} from "./cost";

describe("agent cost", () => {
  it("prices Opus 5.5: $4 in, $20 out, $0.20 cache reads, $5 cache writes per MTok", () => {
    expect(costOf({ input_tokens: 1_000_000 })).toBe(4);
    expect(costOf({ output_tokens: 1_000_000 })).toBe(20);
    expect(costOf({ cache_read_input_tokens: 1_000_000 })).toBe(0.2);
    expect(costOf({ cache_creation_input_tokens: 1_000_000 })).toBe(5);
    // A typical turn 2: 15K cached prefix read, 3K new input, 800 output.
    expect(
      costOf({
        input_tokens: 3000,
        cache_read_input_tokens: 15_000,
        output_tokens: 800,
      })
    ).toBeCloseTo(0.012 + 0.003 + 0.016, 6);
  });

  it("sums every attempt when a fallback ran, each at its own model's price", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      iterations: [
        {
          type: "message",
          model: null,
          input_tokens: 1000,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        {
          type: "fallback_message",
          model: "claude-opus-4-8",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    };
    const s = summarizeUsage(usage, "claude-opus-5-5");
    expect(s.inputTokens).toBe(1100);
    expect(s.outputTokens).toBe(60);
    expect(s.costUsd).toBeCloseTo(
      (1000 * 4 + 10 * 20 + 100 * 5 + 50 * 25) / 1e6,
      6
    );
  });

  it("without iterations uses top-level usage", () => {
    expect(
      summarizeUsage({
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      })
    ).toEqual({
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      costUsd: (10 * 4 + 10 * 20 + 100 * 0.2) / 1e6,
    });
  });

  it("adds and formats", () => {
    const a = summarizeUsage({ input_tokens: 1000, output_tokens: 100 });
    expect(addUsage(ZERO_USAGE, a)).toEqual(a);
    expect(formatUsd(0.0004)).toBe("<$0.001");
    expect(formatUsd(0.0421)).toBe("$0.042");
    expect(formatUsd(1.2)).toBe("$1.20");
  });

  it("prices a fallback iteration without a model at the requested model's rates, not the answering model's", () => {
    const usage = {
      iterations: [
        { type: "message", model: null, input_tokens: 1_000_000 },
        {
          type: "fallback_message",
          model: "claude-opus-4-8",
          output_tokens: 1_000_000,
        },
      ],
    };
    expect(
      summarizeUsage(usage, "claude-opus-4-8", "claude-opus-5-5").costUsd
    ).toBe(4 + 25);
  });
});
