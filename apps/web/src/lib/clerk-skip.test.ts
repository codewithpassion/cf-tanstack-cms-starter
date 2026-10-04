import { expect, test } from "bun:test";
import { skipsClerk } from "./clerk-skip.ts";

test("public, cookieless paths skip Clerk", () => {
  for (const path of [
    "/media/abc.png",
    "/og-render",
    "/og-render/home",
    "/og-render-agent/p1",
    "/mcp",
  ]) {
    expect(skipsClerk(path)).toBe(true);
  }
});

test("everything else goes through Clerk", () => {
  for (const path of ["/", "/admin", "/mcp/extra", "/og-rendering", "/login"]) {
    expect(skipsClerk(path)).toBe(false);
  }
});
