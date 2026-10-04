import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { appRouter } from "./router.ts";

/** Procedures that are deliberately not admin-only. A new one must be added here on purpose. */
const PUBLIC = [
  "cms.public.loadCmsPage",
  "cms.public.getRootSite",
  "cms.public.getBlogIndexData",
  // Both re-check a signed render token themselves.
  "cms.ogRender.getOgRenderData",
  "cms.agentRender.getAgentRenderData",
];
/** Any signed-in user, not only admins. */
const SIGNED_IN = ["me"];

const contextFor = (userId: string | null, emails: string[]): Context => ({
  adminEmails: ["ada@example.com"],
  auth: { userId, verifiedEmails: () => Promise.resolve(emails) },
  // The guard rejects before any service is touched.
  services: {} as Context["services"],
  userId,
});

const callPath = (ctx: Context, path: string) => {
  let target: unknown = appRouter.createCaller(ctx);
  for (const part of path.split(".")) {
    target = (target as Record<string, unknown>)[part];
  }
  // No input: the admin check must run before input is parsed.
  return (target as () => Promise<unknown>)();
};

const paths = Object.keys(appRouter._def.procedures);
const adminOnly = paths.filter(
  (p) => !(PUBLIC.includes(p) || SIGNED_IN.includes(p))
);

test("every allowlisted public or signed-in procedure exists", () => {
  for (const p of [...PUBLIC, ...SIGNED_IN]) {
    expect(paths).toContain(p);
  }
});

test("every other procedure rejects an anonymous caller", async () => {
  expect(adminOnly.length).toBeGreaterThan(50);
  for (const p of [...adminOnly, ...SIGNED_IN]) {
    // biome-ignore lint/performance/noAwaitInLoops: each failure names its procedure.
    await expect(callPath(contextFor(null, []), p)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  }
});

test("every other procedure rejects a signed-in non-admin", async () => {
  for (const p of adminOnly) {
    // biome-ignore lint/performance/noAwaitInLoops: each failure names its procedure.
    await expect(
      callPath(contextFor("u1", ["bob@example.com"]), p)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
});
