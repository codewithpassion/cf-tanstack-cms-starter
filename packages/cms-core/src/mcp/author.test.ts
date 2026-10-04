import { describe, expect, it } from "bun:test";

import { mcpAuthor, parseMcpAuthor } from "./author";

describe("MCP authors", () => {
  it("carries the key prefix, so keys sharing a name stay apart", () => {
    const a = mcpAuthor({ name: "laptop", prefix: "cms_live_Abc12345" });
    const b = mcpAuthor({ name: "laptop", prefix: "cms_live_Xyz98765" });
    expect(a).toBe("mcp:laptop#cms_live_Abc12345");
    expect(a).not.toBe(b);
  });

  it("parses name and prefix for the history badge", () => {
    expect(parseMcpAuthor("mcp:laptop#cms_live_Abc12345")).toEqual({
      name: "laptop",
      prefix: "cms_live_Abc12345",
    });
    // A # in the key name stays in the name.
    expect(parseMcpAuthor("mcp:CI #2#cms_dev_Abc12345")).toEqual({
      name: "CI #2",
      prefix: "cms_dev_Abc12345",
    });
    // Rows written before the prefix was added.
    expect(parseMcpAuthor("mcp:laptop")).toEqual({
      name: "laptop",
      prefix: null,
    });
    expect(parseMcpAuthor("user_2abc")).toBeNull();
    expect(parseMcpAuthor(null)).toBeNull();
  });
});
