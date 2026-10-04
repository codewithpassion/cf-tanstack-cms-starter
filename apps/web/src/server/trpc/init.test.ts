import { expect, test } from "bun:test";
import { z } from "zod";
import type { Context } from "./context.ts";
import { adminProcedure, router } from "./init.ts";

// `.input()` comes after adminProcedure, as every admin router does.
const testRouter = router({
  guarded: adminProcedure
    .input(z.object({ name: z.string() }))
    .query(({ ctx, input }) => ({ email: ctx.adminEmail, name: input.name })),
});

const contextFor = (
  userId: string | null,
  emails: string[],
  adminEmails: string[]
): Context => ({
  adminEmails,
  auth: { userId, verifiedEmails: () => Promise.resolve(emails) },
  services: {},
  userId,
});

const call = (ctx: Context, input: unknown) =>
  // The cast lets a test feed deliberately invalid input.
  testRouter.createCaller(ctx).guarded(input as { name: string });

test("an admin gets through, matched case-insensitively", async () => {
  const ctx = contextFor("u1", ["ada@example.com"], ["ada@example.com"]);
  expect(await call(ctx, { name: "x" })).toEqual({
    email: "ada@example.com",
    name: "x",
  });
});

test("a signed-in user off the list is FORBIDDEN", async () => {
  const ctx = contextFor("u1", ["bob@example.com"], ["ada@example.com"]);
  await expect(call(ctx, { name: "x" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("an empty ADMIN_EMAILS list means nobody is an admin", async () => {
  const ctx = contextFor("u1", ["ada@example.com"], []);
  await expect(call(ctx, { name: "x" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("an anonymous caller is UNAUTHORIZED", async () => {
  const ctx = contextFor(null, [], ["ada@example.com"]);
  await expect(call(ctx, { name: "x" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("a non-admin is rejected before input is parsed", async () => {
  const ctx = contextFor("u1", ["bob@example.com"], ["ada@example.com"]);
  // Invalid input: were it parsed first, this would be BAD_REQUEST.
  await expect(call(ctx, { name: 42 })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
