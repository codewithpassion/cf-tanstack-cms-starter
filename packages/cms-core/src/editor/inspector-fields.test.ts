// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/useErrorMessage: test-only type narrowing throws, as in the source.
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { getBlockDef, listBlockDefs } from "../blocks/registry";
import { mediaIdSchema } from "../media-schema";
import { richTextSchema } from "../richtext/schema";
import {
  altKeptOnReplace,
  defaultValue,
  type FieldSpec,
  fieldForSchema,
  fieldsForSchema,
  humanize,
  mediaPickChanges,
  mediaRemoveChanges,
  newListItem,
  propsPatch,
  propsPatchMany,
  setIn,
  setMany,
} from "./inspector-fields";

const kinds = (fields: FieldSpec[]) =>
  Object.fromEntries(fields.map((f) => [f.name, f.kind]));
const byName = (fields: FieldSpec[], name: string) =>
  fields.find((f) => f.name === name)!;

describe("fieldsForSchema: block schemas", () => {
  it("maps the hero", () => {
    const fields = fieldsForSchema(getBlockDef("hero")!.schema);
    expect(kinds(fields)).toEqual({
      variant: "select",
      eyebrow: "text",
      heading: "text",
      headingAccent: "text",
      lead: "text",
      primary: "link",
      secondary: "link",
      tertiary: "link",
      // This site's hero logo is an optional media image (blocks/hero.tsx), not the source's on/off + alt.
      logo: "object",
    });
    expect(byName(fields, "variant")).toMatchObject({
      options: [
        { value: "page", label: "Page" },
        { value: "minimal", label: "Minimal" },
        { value: "home", label: "Home" },
      ],
    });
    expect(byName(fields, "heading")).toMatchObject({
      label: "Heading",
      optional: false,
      multiline: false,
      maxLength: 200,
    });
    expect(byName(fields, "lead")).toMatchObject({
      optional: true,
      multiline: true,
    });
    expect(byName(fields, "secondary")).toMatchObject({ optional: true });
  });

  it("maps the feature grid: numeric literal union, keyed list with nested rich text and optional enum", () => {
    const fields = fieldsForSchema(getBlockDef("featureGrid")!.schema);
    expect(byName(fields, "columns")).toMatchObject({
      kind: "select",
      options: [
        { value: 2, label: "2" },
        { value: 3, label: "3" },
        { value: 4, label: "4" },
      ],
    });
    const items = byName(fields, "items");
    expect(items).toMatchObject({
      kind: "list",
      min: 1,
      max: 24,
      itemLabelField: "title",
    });
    if (items.kind !== "list") {
      throw new Error();
    }
    expect(kinds(items.itemFields)).toEqual({
      icon: "select",
      title: "text",
      body: "richText",
      link: "link",
    });
    expect(byName(items.itemFields, "icon").optional).toBe(true);
    expect(byName(items.itemFields, "link").optional).toBe(true);
  });

  it("uses .describe() labels (faq) and finds rich text through .describe()", () => {
    const items = byName(fieldsForSchema(getBlockDef("faq")!.schema), "items");
    if (items.kind !== "list") {
      throw new Error();
    }
    expect(items.itemFields.map((f) => [f.name, f.kind, f.label])).toEqual([
      ["q", "text", "Question"],
      ["a", "richText", "Answer"],
    ]);
  });

  it("maps the image block: media id and integer numbers", () => {
    const fields = fieldsForSchema(getBlockDef("image")!.schema);
    expect(kinds(fields)).toEqual({
      mediaId: "media",
      alt: "text",
      caption: "text",
      width: "number",
      height: "number",
    });
    expect(byName(fields, "width")).toMatchObject({
      integer: true,
      min: 1,
      max: 16_384,
      optional: true,
    });
  });

  it("every registered block maps without unsupported fields", () => {
    for (const def of listBlockDefs()) {
      const walk = (fields: FieldSpec[]): string[] =>
        fields.flatMap((f) =>
          f.kind === "unsupported"
            ? [`${def.type}.${f.name}`]
            : f.kind === "list"
              ? walk(f.itemFields)
              : f.kind === "object"
                ? walk(f.fields)
                : []
        );
      expect(walk(fieldsForSchema(def.schema))).toEqual([]);
    }
  });
});

describe("fieldForSchema: primitives", () => {
  it("booleans, nested objects, unsupported shapes", () => {
    expect(fieldForSchema("featured", z.boolean())).toMatchObject({
      kind: "boolean",
      label: "Featured",
    });
    expect(fieldForSchema("meta", z.object({ a: z.string() }))).toMatchObject({
      kind: "object",
      fields: [{ name: "a", kind: "text" }],
    });
    expect(fieldForSchema("tags", z.array(z.string())).kind).toBe(
      "unsupported"
    );
    expect(fieldForSchema("body", richTextSchema.optional()).kind).toBe(
      "richText"
    );
  });

  it("humanizes keys", () => {
    expect(humanize("breadcrumbLabel")).toBe("Breadcrumb label");
    expect(humanize("_key")).toBe("Key");
    expect(humanize("graduation-cap")).toBe("Graduation cap");
  });
});

describe("values and patches", () => {
  it("new list items are valid against the item schema", () => {
    const def = getBlockDef("featureGrid")!;
    const items = byName(fieldsForSchema(def.schema), "items");
    if (items.kind !== "list") {
      throw new Error();
    }
    const item = newListItem(items.itemFields);
    expect(item._key).toMatch(/^.{8}$/);
    const props = { ...def.defaults(), items: [item] };
    expect(def.schema.safeParse(props).success).toBe(true);
  });

  it("defaultValue for a required link is a valid button", () => {
    const def = getBlockDef("cta")!;
    const primary = byName(fieldsForSchema(def.schema), "primary");
    expect(
      def.schema.safeParse({
        ...def.defaults(),
        primary: defaultValue(primary),
      }).success
    ).toBe(true);
  });

  it("setIn sets and deletes immutably", () => {
    const src = { a: { b: 1, c: 2 }, list: [{ x: 1 }, { x: 2 }] };
    const out = setIn(src, ["list", 1, "x"], 3) as typeof src;
    expect(out.list[1]!.x).toBe(3);
    expect(src.list[1]!.x).toBe(2);
    expect(out.list[0]).toBe(src.list[0]);
    expect(setIn(src, ["a", "b"], undefined)).toEqual({
      a: { c: 2 },
      list: src.list,
    });
  });

  it("propsPatch: top-level set and delete, nested merge, arrays wholesale", () => {
    const props = {
      heading: "H",
      lead: "L",
      primary: { label: "Go", href: "/x" },
      items: [{ _key: "a", title: "A" }],
    };
    expect(propsPatch(props, ["heading"], "New")).toEqual({ heading: "New" });
    expect(propsPatch(props, ["lead"], undefined)).toEqual({ lead: null });
    expect(propsPatch(props, ["primary", "href"], "/y")).toEqual({
      primary: { href: "/y" },
    });
    expect(propsPatch(props, ["items", 0, "title"], "B")).toEqual({
      items: [{ _key: "a", title: "B" }],
    });
  });
});

describe("media id fields", () => {
  const ID = `${"a".repeat(64)}.jpg`;
  const OTHER = `${"b".repeat(64)}.png`;

  it("are recognised by mediaIdSchema through optional, nullable, default and describe wrappers", () => {
    for (const schema of [
      mediaIdSchema,
      mediaIdSchema.optional(),
      mediaIdSchema.nullable(),
      mediaIdSchema.default(ID),
      mediaIdSchema.describe("Logo"),
      mediaIdSchema.optional().describe("Avatar"),
      mediaIdSchema.describe("Photo").optional(),
    ]) {
      expect(fieldForSchema("anything", schema).kind).toBe("media");
    }
    expect(
      fieldForSchema("logo", mediaIdSchema.describe("Logo"))
    ).toMatchObject({ kind: "media", label: "Logo" });
  });

  it("are not guessed from the key or a look-alike string schema", () => {
    const lookAlike = z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/);
    expect(fieldForSchema("mediaId", lookAlike).kind).toBe("text");
    expect(fieldForSchema("image", z.string()).kind).toBe("text");
  });

  it("covers every media field in the registry, with the siblings an image pick fills", () => {
    const found: [string, unknown][] = [];
    for (const def of listBlockDefs()) {
      const walk = (fields: FieldSpec[], at: string) => {
        for (const f of fields) {
          if (f.kind === "media") {
            found.push([`${at}.${f.name}`, f.fill]);
          } else if (f.kind === "list") {
            walk(f.itemFields, `${at}.${f.name}[]`);
          } else if (f.kind === "object") {
            walk(f.fields, `${at}.${f.name}`);
          }
        }
      };
      walk(fieldsForSchema(def.schema), def.type);
    }
    expect(Object.fromEntries(found)).toEqual({
      "hero.logo.mediaId": { alt: "alt" },
      "image.mediaId": { alt: "alt", width: "width", height: "height" },
      "logos.items[].image": {},
      "testimonial.items[].image": {},
    });
  });

  it("picking fills width, height and an empty alt, in one patch that validates", () => {
    const def = getBlockDef("image")!;
    const props = { alt: "" };
    const changes = mediaPickChanges(
      props,
      ["mediaId"],
      { alt: "alt", width: "width", height: "height" },
      {
        id: ID,
        alt: "A river at dawn",
        width: 1600,
        height: 900,
      }
    );
    expect(propsPatchMany(props, changes)).toEqual({
      mediaId: ID,
      width: 1600,
      height: 900,
      alt: "A river at dawn",
    });
    expect(def.schema.safeParse(setMany(props, changes)).success).toBe(true);
  });

  it("replacing keeps alt text the page wrote and dimensions set by hand, and notes the kept alt", () => {
    const props = { mediaId: ID, alt: "Our team", width: 800, height: 600 };
    const fill = { alt: "alt", width: "width", height: "height" };
    const previous = {
      id: ID,
      alt: "Library alt for the old photo",
      width: 1600,
      height: 1200,
    };
    const next = { id: OTHER, alt: "Library alt", width: 400, height: 300 };
    const changes = mediaPickChanges(props, ["mediaId"], fill, next, previous);
    expect(propsPatchMany(props, changes)).toEqual({ mediaId: OTHER });
    expect(altKeptOnReplace(props, ["mediaId"], fill, next, previous)).toBe(
      true
    );
  });

  it("replacing overwrites alt and dimensions that came from the previous image's library record", () => {
    const props = {
      mediaId: ID,
      alt: "Old library alt",
      width: 800,
      height: 600,
    };
    const fill = { alt: "alt", width: "width", height: "height" };
    const previous = {
      id: ID,
      alt: "Old library alt ",
      width: 800,
      height: 600,
    };
    const next = {
      id: OTHER,
      alt: "New library alt",
      width: null,
      height: 300,
    };
    const changes = mediaPickChanges(props, ["mediaId"], fill, next, previous);
    expect(propsPatchMany(props, changes)).toEqual({
      mediaId: OTHER,
      width: null,
      height: 300,
      alt: "New library alt",
    });
    expect(altKeptOnReplace(props, ["mediaId"], fill, next, previous)).toBe(
      false
    );
    // The new image has no library alt: the old image's alt goes anyway (empty alt shows in the checks).
    expect(
      setMany(
        props,
        mediaPickChanges(
          props,
          ["mediaId"],
          fill,
          { ...next, alt: null },
          previous
        )
      )
    ).toMatchObject({ alt: "" });
  });

  it("with the previous image unknown, only unset fields are filled", () => {
    const props = { mediaId: ID, alt: "", width: 800 };
    const fill = { alt: "alt", width: "width", height: "height" };
    const changes = mediaPickChanges(
      props,
      ["mediaId"],
      fill,
      { id: OTHER, alt: "Library alt", width: 10, height: 20 },
      null
    );
    expect(propsPatchMany(props, changes)).toEqual({
      mediaId: OTHER,
      height: 20,
      alt: "Library alt",
    });
    expect(
      altKeptOnReplace({ alt: "x" }, ["mediaId"], fill, { id: OTHER }, null)
    ).toBe(false); // first pick: nothing replaced
  });

  it("picking image dimensions up to the library's limit validates", () => {
    const def = getBlockDef("image")!;
    const changes = mediaPickChanges(
      { alt: "" },
      ["mediaId"],
      { width: "width", height: "height" },
      { id: ID, width: 16_384, height: 12_000 }
    );
    expect(def.schema.safeParse(setMany({ alt: "" }, changes)).success).toBe(
      true
    );
  });

  it("picking into a list item replaces the list once, with the item's other fields intact", () => {
    const props = {
      items: [
        { _key: "a", name: "MIT" },
        { _key: "b", name: "Acme", image: ID },
      ],
    };
    const changes = mediaPickChanges(
      props,
      ["items", 0, "image"],
      {},
      { id: OTHER, alt: "x", width: 10, height: 10 }
    );
    expect(changes).toEqual([{ path: ["items", 0, "image"], value: OTHER }]);
    expect(propsPatchMany(props, changes)).toEqual({
      items: [
        { _key: "a", name: "MIT", image: OTHER },
        { _key: "b", name: "Acme", image: ID },
      ],
    });
  });

  it("removing drops the id and its dimensions, and the alt text only when it was the library's", () => {
    const fill = { alt: "alt", width: "width", height: "height" };
    const props = { mediaId: ID, alt: "Our team", width: 800, height: 600 };
    const removed = { id: ID, alt: "Library alt", width: 800, height: 600 };
    const changes = mediaRemoveChanges(props, ["mediaId"], fill, removed);
    expect(propsPatchMany(props, changes)).toEqual({
      mediaId: null,
      width: null,
      height: null,
    });
    expect(setMany(props, changes)).toEqual({ alt: "Our team" });
    const fromLibrary = { ...props, alt: "Library alt" };
    expect(
      setMany(
        fromLibrary,
        mediaRemoveChanges(fromLibrary, ["mediaId"], fill, removed)
      )
    ).toEqual({ alt: "" });
    expect(
      setMany(
        fromLibrary,
        mediaRemoveChanges(fromLibrary, ["mediaId"], fill, null)
      )
    ).toEqual({ alt: "Library alt" });
  });

  it("propsPatchMany: later list patches carry earlier changes to the same list", () => {
    const props = { items: [{ _key: "a", t: "1", u: "1" }], heading: "H" };
    const patch = propsPatchMany(props, [
      { path: ["items", 0, "t"], value: "2" },
      { path: ["items", 0, "u"], value: "3" },
      { path: ["heading"], value: "New" },
    ]);
    expect(patch).toEqual({
      items: [{ _key: "a", t: "2", u: "3" }],
      heading: "New",
    });
  });

  it("propsPatchMany: nested object patches merge", () => {
    const props = { primary: { label: "Go", href: "/x" } };
    expect(
      propsPatchMany(props, [
        { path: ["primary", "label"], value: "Start" },
        { path: ["primary", "href"], value: "/y" },
      ])
    ).toEqual({ primary: { label: "Start", href: "/y" } });
  });
});
