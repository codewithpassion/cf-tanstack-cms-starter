import { describe, expect, it } from "bun:test";
import { isAdminPath, needsCsrfCheck } from "./csrf-filter";

const check = (method: string, pathname: string) =>
  needsCsrfCheck({
    pathname,
    request: new Request(`https://example.com${pathname}`, { method }),
  });

describe("needsCsrfCheck", () => {
  it("checks state-changing requests under /admin, such as the media upload", () => {
    expect(check("POST", "/admin/api/media")).toBe(true);
    expect(check("PUT", "/admin")).toBe(true);
    expect(check("DELETE", "/admin/pages")).toBe(true);
  });

  it("leaves reads and public paths alone", () => {
    expect(check("GET", "/admin/api/media")).toBe(false);
    expect(check("HEAD", "/admin/pages")).toBe(false);
    expect(check("POST", "/api/subscribe")).toBe(false);
    expect(check("GET", "/media/x.png")).toBe(false);
  });

  it("leaves the MCP server alone: it takes a bearer key, never cookies", () => {
    expect(check("POST", "/mcp")).toBe(false);
    expect(check("GET", "/mcp")).toBe(false);
    expect(check("DELETE", "/mcp")).toBe(false);
  });
});

describe("isAdminPath", () => {
  it("matches /admin and below, not look-alikes", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/editor/x")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
  });
});
