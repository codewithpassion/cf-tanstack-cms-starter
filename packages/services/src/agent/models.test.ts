import { describe, expect, it } from "bun:test";
import { createMemoryAgentStore } from "./memory-store";
import {
  modelOptions,
  type ProviderFactories,
  providerFor,
  unavailableReason,
} from "./models";
import type { ModelProvider } from "./provider";

describe("model availability", () => {
  it("says why a model can't run", () => {
    expect(
      unavailableReason(
        { anthropic: false, workersAi: true },
        { provider: "anthropic" }
      )
    ).toContain("ANTHROPIC_API_KEY");
    expect(
      unavailableReason(
        { anthropic: true, workersAi: false },
        { provider: "workers-ai" }
      )
    ).toContain("no AI binding");
    expect(
      unavailableReason(
        { anthropic: true, workersAi: true, workersAiOff: "off in dev" },
        { provider: "workers-ai" }
      )
    ).toBe("off in dev");
    expect(
      unavailableReason(
        { anthropic: true, workersAi: true },
        { provider: "workers-ai" }
      )
    ).toBeNull();
  });

  it("lists the built-in models with their availability", async () => {
    const options = await modelOptions(
      { anthropic: true, workersAi: false },
      createMemoryAgentStore()
    );
    expect(options.some((m) => m.provider === "anthropic" && m.available)).toBe(
      true
    );
    expect(
      options
        .filter((m) => m.provider === "workers-ai")
        .every((m) => !m.available && m.reason)
    ).toBe(true);
  });

  it("builds the provider for a thread's model from the factories", () => {
    const made: string[] = [];
    const fake = (
      id: "anthropic" | "workers-ai",
      model: string
    ): ModelProvider => ({
      id,
      model,
      step: async () => null,
      toolResultRows: () => [],
    });
    const factories: ProviderFactories = {
      anthropic: () => {
        made.push("claude");
        return fake("anthropic", "c");
      },
      workersAi: (model) => {
        made.push(model);
        return fake("workers-ai", model);
      },
    };
    const hydrate = () => async (c: unknown) => c as never;
    providerFor(factories, { provider: "workers-ai", id: "@cf/x" }, hydrate);
    providerFor(factories, { provider: "anthropic", id: "claude" }, hydrate);
    expect(made).toEqual(["@cf/x", "claude"]);
  });
});
