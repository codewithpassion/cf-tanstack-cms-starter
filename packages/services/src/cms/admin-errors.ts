import { OpError } from "@repo/cms-core/ops/apply-ops";

import type { AdminError, AdminResult } from "./admin-result";
import { CmsError } from "./pages-service";

/**
 * Maps the page service's expected failures (CmsError, OpError) to a typed result, so the editor
 * gets `{ ok: false, code, message, path? }` instead of a 500. Anything else is a bug or an outage
 * and is rethrown. Server-only in practice: imported by admin-fns.ts handlers and tests.
 */
export function toAdminError(err: unknown): AdminError | null {
  if (err instanceof CmsError) {
    const path = errorPath(err.details);
    return {
      ok: false,
      code: err.code,
      message: firstMessage(err),
      ...(path !== undefined && { path }),
    };
  }
  if (err instanceof OpError) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
      path: `ops[${err.opIndex}]`,
    };
  }
  return null;
}

/** Runs `fn` and wraps its value as `{ ok: true, ...value }`, or maps an expected failure. */
export async function adminResult<T extends object>(
  fn: () => Promise<T>
): Promise<AdminResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    const mapped = toAdminError(err);
    if (mapped) {
      return mapped;
    }
    throw err;
  }
}

type PathError = { path: string; message: string };

const isPathErrors = (v: unknown): v is PathError[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((e) => typeof e?.path === "string" && typeof e?.message === "string");

/** Validation details are `{ path, message }[]`; `applied()` reports `{ opIndex }`. */
function errorPath(details: unknown): string | undefined {
  if (isPathErrors(details)) {
    return details[0]?.path;
  }
  const opIndex = (details as { opIndex?: unknown } | undefined)?.opIndex;
  if (typeof opIndex === "number") {
    return `ops[${opIndex}]`;
  }
}

/** For validation failures, the first concrete problem reads better than "document failed validation". */
function firstMessage(err: CmsError): string {
  if (isPathErrors(err.details)) {
    const [first] = err.details;
    if (first) {
      return first.path ? `${first.path}: ${first.message}` : first.message;
    }
  }
  return err.message;
}
