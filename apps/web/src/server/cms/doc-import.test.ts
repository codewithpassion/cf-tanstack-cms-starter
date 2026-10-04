import { beforeEach, describe, expect, it } from "bun:test";
import { newPageDoc } from "@repo/cms-core/new-docs";
import { validatePageDoc } from "@repo/cms-core/validate";
import {
  getPage,
  listRevisions,
  type ServiceDeps,
} from "@repo/services/cms/pages-service";
import { createMemoryRepo } from "@repo/services/testing/memory-repo";
import {
  type ImportTarget,
  planImport,
  runImport,
  SETUP_IMPORTS,
  STARTER_IMPORT_TARGETS,
} from "./doc-import.ts";

let kv: Map<string, string>;
let d: ServiceDeps;
let ids: number;

beforeEach(() => {
  ids = 0;
  kv = new Map();
  d = {
    repo: createMemoryRepo().repo,
    kv: {
      get: (key) => Promise.resolve(kv.get(key) ?? null),
      put: (key, value) => {
        kv.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        kv.delete(key);
        return Promise.resolve();
      },
    },
    // The real validator, so the imported document is checked as a save would.
    validate: validatePageDoc,
    labelFor: (type) => type,
    now: () => Date.parse("2026-10-03T00:00:00Z"),
    genId: () => {
      ids += 1;
      return `id${ids}`;
    },
  };
});

const SLUG = "about";
const TITLE = "About us";
const doc = newPageDoc(TITLE, SLUG);
const targets: ImportTarget[] = [
  { kind: "page", slug: SLUG, title: TITLE, doc: () => structuredClone(doc) },
];

describe("doc import", () => {
  it("offers the starter content, empty until it is written", () => {
    expect(SETUP_IMPORTS.starter()).toBe(STARTER_IMPORT_TARGETS);
  });

  it("a dry run plans to create the page and writes nothing", async () => {
    expect(await planImport(d, targets)).toEqual([
      { path: `/${SLUG}`, title: TITLE, pageId: null, action: "create" },
    ]);
    expect(await getPage(d, { slug: SLUG })).toBeNull();
  });

  it("creates a draft holding exactly the document; never publishes", async () => {
    const [result] = await runImport(d, targets);
    expect(result).toMatchObject({ path: `/${SLUG}`, action: "create" });
    const page = await getPage(d, { slug: SLUG });
    expect(page?.status).toBe("draft");
    expect(page?.kind).toBe("page");
    expect(page?.draftDoc).toEqual(doc);
    expect(page?.liveRevId).toBeNull();
    expect(kv.size).toBe(0);
  });

  it("is idempotent: a second run (and a dry run) skip the existing page and change nothing", async () => {
    await runImport(d, targets);
    const before = await getPage(d, { slug: SLUG });
    const revisions = await listRevisions(d, before?.id ?? "");
    expect(await planImport(d, targets)).toMatchObject([
      { action: "skip", pageId: before?.id, status: "draft" },
    ]);
    expect(await runImport(d, targets)).toMatchObject([
      { action: "skip", pageId: before?.id, status: "draft" },
    ]);
    expect(await getPage(d, { slug: SLUG })).toEqual(before);
    expect(await listRevisions(d, before?.id ?? "")).toEqual(revisions);
  });
});
