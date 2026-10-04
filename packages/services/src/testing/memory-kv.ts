/**
 * Test helper: an in-memory KV namespace covering what @cloudflare/workers-oauth-provider calls:
 * get (text or json), put (with metadata and expiration), delete, and list (prefix, limit, cursor,
 * key metadata), sorted by key like KV. Expired entries read as missing. Not imported by app code.
 * `kv` satisfies `KvPort`; a test that needs a real `KVNamespace` type casts it.
 */
type Entry = {
  expiresAt?: number;
  metadata?: unknown;
  value: string;
};
type GetType = "text" | "json";

export function createMemoryKv(now: () => number = Date.now) {
  const store = new Map<string, Entry>();
  const live = (key: string) => {
    const e = store.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= now() / 1000) {
      store.delete(key);
      return;
    }
    return e;
  };
  const kv = {
    delete(key: string) {
      store.delete(key);
      return Promise.resolve();
    },
    get(key: string, opts?: GetType | { type?: GetType }) {
      const e = live(key);
      if (!e) {
        return Promise.resolve(null);
      }
      const type = typeof opts === "string" ? opts : opts?.type;
      return Promise.resolve(type === "json" ? JSON.parse(e.value) : e.value);
    },
    list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const names = [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? "") && live(k))
        .sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? 1000;
      const done = start + limit >= names.length;
      const keys = names.slice(start, start + limit).map((name) => {
        const e = store.get(name);
        return {
          name,
          ...(e?.metadata !== undefined && { metadata: e.metadata }),
          ...(e?.expiresAt !== undefined && {
            expiration: Math.floor(e.expiresAt),
          }),
        };
      });
      return Promise.resolve({
        keys,
        list_complete: done,
        ...(!done && { cursor: String(start + limit) }),
      });
    },
    put(
      key: string,
      value: string,
      opts: {
        expiration?: number;
        expirationTtl?: number;
        metadata?: unknown;
      } = {}
    ) {
      const ttlEnd =
        opts.expirationTtl === undefined
          ? undefined
          : now() / 1000 + opts.expirationTtl;
      store.set(key, {
        expiresAt: opts.expiration ?? ttlEnd,
        metadata: opts.metadata,
        value,
      });
      return Promise.resolve();
    },
  };
  return { kv, store };
}
