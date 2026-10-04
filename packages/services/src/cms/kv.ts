/**
 * The part of a Workers KV namespace the page and site services use. `KVNamespace` fits it (its
 * `get(key)` returns `string | null`), and so does a Map-backed fake.
 */
export type KvPort = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};
