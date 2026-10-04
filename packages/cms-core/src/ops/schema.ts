import { z } from "zod";

import type { Op } from "../types";

/**
 * Structural check for ops arriving at the server boundary. Block contents
 * are checked afterwards by validating the resulting document. Inserted and replacing blocks must
 * carry `_key`, so the server never generates keys the client doesn't know about.
 */

const keySchema = z.string().min(1).max(64);
const patchSchema = z.record(z.string(), z.unknown());

const insertAtSchema = z.strictObject({
  after: keySchema.optional(),
  before: keySchema.optional(),
  index: z.number().int().min(0).optional(),
});

const keyedBlockSchema = z.strictObject({
  _key: keySchema,
  _type: z.string().min(1),
  _v: z.number().int().min(1).optional(),
  props: z.unknown(),
  style: z.unknown().optional(),
});

export const opSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("insert"),
    at: insertAtSchema,
    block: keyedBlockSchema,
  }),
  z.strictObject({
    op: z.literal("update"),
    key: keySchema,
    props: patchSchema.optional(),
    style: patchSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("replace"),
    key: keySchema,
    block: keyedBlockSchema,
  }),
  z.strictObject({ op: z.literal("move"), key: keySchema, to: insertAtSchema }),
  z.strictObject({ op: z.literal("remove"), key: keySchema }),
  z.strictObject({ op: z.literal("setSeo"), seo: patchSchema }),
  z.strictObject({ op: z.literal("setPost"), post: patchSchema }),
]);

export const opsSchema = z.array(opSchema);

/** Arrays and objects nested deeper than this are rejected before anything recurses over them. */
export const MAX_OPS_DEPTH = 64;

/** Iterative, so a hostile payload can't overflow the stack (like the rich-text depth scan). */
function tooDeep(input: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  for (let top = stack.pop(); top; top = stack.pop()) {
    const { value, depth } = top;
    if (typeof value !== "object" || value === null) {
      continue;
    }
    if (depth + 1 > MAX_OPS_DEPTH) {
      return true;
    }
    for (const child of Object.values(value)) {
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

/** Error paths look like `ops[0].block._key`. */
export function parseOps(
  input: unknown
):
  | { ok: true; ops: Op[] }
  | { ok: false; errors: { path: string; message: string }[] } {
  if (tooDeep(input)) {
    return {
      ok: false,
      errors: [
        {
          path: "ops",
          message: `Ops are nested more than ${MAX_OPS_DEPTH} deep`,
        },
      ],
    };
  }
  const result = opsSchema.safeParse(input);
  if (result.success) {
    return { ok: true, ops: result.data as Op[] };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.reduce<string>(
        (p, k) => (typeof k === "number" ? `${p}[${k}]` : `${p}.${String(k)}`),
        "ops"
      ),
      message: issue.message,
    })),
  };
}
