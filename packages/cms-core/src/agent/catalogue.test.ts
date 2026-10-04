import { describe, expect, it } from "bun:test";

import { BLOCK_TYPES, getBlockDef } from "../blocks/registry";
import { TEST_CONFIG } from "../test-fixtures";
import { blockCatalogue } from "./catalogue";
import { systemPrompt } from "./prompt";

// Every block's `ai` guidance reaches the agent only through the generated catalogue.
describe("blockCatalogue", () => {
  it("lists every registered block type with its ai guidance, and the prompt carries it", () => {
    const catalogue = blockCatalogue();
    for (const type of BLOCK_TYPES) {
      const def = getBlockDef(type);
      expect(def?.ai).toBeTruthy();
      expect(catalogue).toContain(type);
      expect(catalogue).toContain(String(def?.ai).slice(0, 60));
    }
    expect(systemPrompt(TEST_CONFIG).join("\n")).toContain(catalogue);
  });
});
