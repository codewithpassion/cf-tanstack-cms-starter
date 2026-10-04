/**
 * Binds a service's ports to its functions: `bindDeps(deps, { a, b })` returns `{ a, b }` with
 * `deps` already passed as the first argument. The service modules are plain functions over a deps
 * object (easy to test one at a time); the `create*Service` factories use this to hand the web app
 * an object it constructs once.
 */
export type Bound<D, T> = {
  [K in keyof T]: T[K] extends (d: D, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};

export function bindDeps<
  D,
  T extends Record<string, (d: D, ...args: never[]) => unknown>,
>(deps: D, fns: T): Bound<D, T> {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(fns)) {
    out[name] = (...args: unknown[]) =>
      (fn as (d: D, ...rest: unknown[]) => unknown)(deps, ...args);
  }
  return out as Bound<D, T>;
}
