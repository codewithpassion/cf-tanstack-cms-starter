import { describe, expect, it } from "bun:test";
import { sampleSeo } from "../test-fixtures";
import { validatePageDoc } from "../validate";
import {
  BLOCK_DEFS,
  BLOCK_TYPES,
  createBlock,
  getBlockDef,
  listBlockDefs,
  migrateProps,
} from "./registry";

const KEBAB_RE = /^[a-z]+(-[a-z]+)*$/;

describe("block def registry", () => {
  it.each([...BLOCK_TYPES])("%s: def is complete and pure data", (type) => {
    const def = BLOCK_DEFS[type];
    expect(def.type).toBe(type);
    expect(def.icon).toMatch(KEBAB_RE);
    expect(def.ai.length).toBeGreaterThan(20);
    expect(Object.keys(def)).not.toContain("Component");
    expect(getBlockDef(type)).toBe(def);
  });

  it.each([...BLOCK_TYPES])(
    "%s: a new block validates inside a page",
    (type) => {
      const result = validatePageDoc({
        _schema: 1,
        seo: sampleSeo(),
        blocks: [createBlock(type, { _key: "b1" })],
      });
      expect(result).toMatchObject({ ok: true });
    }
  );

  it("lists one def per type and no dropped event blocks", () => {
    expect(listBlockDefs().map((d) => d.type)).toEqual([...BLOCK_TYPES]);
    expect(BLOCK_TYPES).toHaveLength(14);
    expect(getBlockDef("eventHero")).toBeUndefined();
  });

  it("migrateProps rejects a newer version and passes the current one", () => {
    const def = BLOCK_DEFS.hero;
    expect(migrateProps(def, def.version + 1, {}).ok).toBe(false);
    expect(migrateProps(def, def.version, { a: 1 })).toEqual({
      ok: true,
      props: { a: 1 },
    });
  });
});
