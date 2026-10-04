// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting it would make the port hard to diff against the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noEqualsToNull: `!= null` deliberately matches null and undefined.
import { nanoid } from "nanoid";
import type { z } from "zod";

import { buttonSchema } from "../links";
import { mediaIdSchema } from "../media-schema";
import { richTextFromString, richTextSchema } from "../richtext/schema";

/**
 * The Content inspector is generated from each block's Zod schema:
 * `fieldsForSchema` maps a schema to field specs, the inspector renders one control per spec.
 * Pure (no React), so the mapping is unit-tested. Labels come from `.describe()` or the key.
 */

type Base = { name: string; label: string; optional: boolean };

export type SelectOption = { value: string | number; label: string };

export type FieldSpec =
  | (Base & { kind: "text"; multiline: boolean; maxLength?: number })
  | (Base & { kind: "number"; integer: boolean; min?: number; max?: number })
  | (Base & { kind: "boolean" })
  | (Base & { kind: "select"; options: SelectOption[] })
  | (Base & { kind: "richText" })
  | (Base & { kind: "media"; fill: MediaFill })
  | (Base & { kind: "link" })
  | (Base & { kind: "object"; fields: FieldSpec[] })
  | (Base & {
      kind: "list";
      itemFields: FieldSpec[];
      min?: number;
      max?: number;
      itemLabelField?: string;
    })
  | (Base & { kind: "unsupported" });

export type FieldKind = FieldSpec["kind"];

/**
 * Sibling fields a picked image fills in, by key: `alt` (a text field) and `width` and `height`
 * (number fields); `mediaPickChanges` says when each is overwritten. Found next to the media field in the same object, e.g.
 * the image block's `mediaId` + `alt`/`width`/`height`.
 */
export type MediaFill = { alt?: string; width?: string; height?: string };

/** Strings longer than this get a textarea. */
const MULTILINE_OVER = 200;

// Zod 4 internals: every schema carries `_zod.def` with a `type` tag.
type AnyDef = {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  options?: z.ZodType[];
  entries?: Record<string, string | number>;
  values?: unknown[];
  checks?: {
    _zod: { def: { check: string; minimum?: number; maximum?: number } };
  }[];
};

const defOf = (s: z.ZodType): AnyDef =>
  (s as unknown as { _zod: { def: AnyDef } })._zod.def;
const descriptionOf = (s: z.ZodType): string | undefined =>
  (s as { description?: string }).description;

/** Optional/nullable/default wrappers, outermost first: their descriptions and optionality count. */
function unwrap(schema: z.ZodType): {
  inner: z.ZodType;
  optional: boolean;
  description?: string;
} {
  let s = schema;
  let optional = false;
  let description = descriptionOf(s);
  for (;;) {
    const def = defOf(s);
    if (
      (def.type === "optional" ||
        def.type === "nullable" ||
        def.type === "default") &&
      def.innerType
    ) {
      optional ||= def.type !== "default";
      s = def.innerType;
      description ??= descriptionOf(s);
      continue;
    }
    return { inner: s, optional, description };
  }
}

/** "breadcrumbLabel" → "Breadcrumb label", "_key" → "Key". */
export function humanize(key: string): string {
  const words = key
    .replace(/^_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function arrayBounds(def: AnyDef): { min?: number; max?: number } {
  const out: { min?: number; max?: number } = {};
  for (const c of def.checks ?? []) {
    if (c._zod.def.check === "min_length") {
      out.min = c._zod.def.minimum;
    }
    if (c._zod.def.check === "max_length") {
      out.max = c._zod.def.maximum;
    }
  }
  return out;
}

/** The field spec for one property schema. */
export function fieldForSchema(name: string, schema: z.ZodType): FieldSpec {
  const { inner, optional, description } = unwrap(schema);
  const base: Base = { name, label: description ?? humanize(name), optional };
  // By definition, not instance: `.describe()` clones a schema but keeps its def.
  const def = defOf(inner);
  if (def === defOf(richTextSchema)) {
    return { ...base, kind: "richText" };
  }
  // A media id field is recognised by `mediaIdSchema`'s def (shared by `.optional()`, `.describe()`
  // and other wrappers), never by its key: "image", "logo", "mediaId" all work.
  if (def === defOf(mediaIdSchema)) {
    return {
      ...base,
      kind: "media",
      fill: {},
      ...(!description && name === "mediaId" && { label: "Image" }),
    };
  }
  if (def === defOf(buttonSchema)) {
    return { ...base, kind: "link" };
  }

  switch (def.type) {
    case "string": {
      const maxLength =
        (inner as { maxLength?: number | null }).maxLength ?? undefined;
      return {
        ...base,
        kind: "text",
        multiline: maxLength === undefined || maxLength > MULTILINE_OVER,
        maxLength,
      };
    }
    case "number": {
      const n = inner as {
        minValue?: number | null;
        maxValue?: number | null;
        isInt?: boolean;
        format?: string | null;
      };
      return {
        ...base,
        kind: "number",
        integer: Boolean(n.isInt) || n.format === "safeint",
        ...(n.minValue != null &&
          Number.isFinite(n.minValue) && { min: n.minValue }),
        ...(n.maxValue != null &&
          Number.isFinite(n.maxValue) && { max: n.maxValue }),
      };
    }
    case "boolean":
      return { ...base, kind: "boolean" };
    case "enum":
      return {
        ...base,
        kind: "select",
        options: Object.values(def.entries ?? {}).map((v) => ({
          value: v,
          label: humanize(String(v)),
        })),
      };
    case "literal":
      return {
        ...base,
        kind: "select",
        options: (def.values ?? []).map(literalOption),
      };
    case "union": {
      const literals = (def.options ?? []).map((o) => defOf(o));
      if (literals.length && literals.every((d) => d.type === "literal")) {
        return {
          ...base,
          kind: "select",
          options: literals.flatMap((d) => (d.values ?? []).map(literalOption)),
        };
      }
      return { ...base, kind: "unsupported" };
    }
    case "object":
      return { ...base, kind: "object", fields: fieldsForSchema(inner) };
    case "array": {
      const element = def.element && unwrap(def.element).inner;
      if (
        element &&
        defOf(element).type === "object" &&
        defOf(element).shape?._key
      ) {
        const itemFields = fieldsForSchema(element).filter(
          (f) => f.name !== "_key"
        );
        const labelField = itemFields.find(
          (f) => f.kind === "text" && !f.optional
        )?.name;
        return {
          ...base,
          kind: "list",
          itemFields,
          ...arrayBounds(def),
          ...(labelField && { itemLabelField: labelField }),
        };
      }
      return { ...base, kind: "unsupported" };
    }
    default:
      return { ...base, kind: "unsupported" };
  }
}

function literalOption(v: unknown): SelectOption {
  return typeof v === "number"
    ? { value: v, label: String(v) }
    : { value: String(v), label: humanize(String(v)) };
}

/** Field specs for an object schema's properties, in declaration order. */
export function fieldsForSchema(schema: z.ZodType): FieldSpec[] {
  const { inner } = unwrap(schema);
  const shape = defOf(inner).shape;
  if (!shape) {
    return [];
  }
  const fields = Object.entries(shape).map(([name, s]) =>
    fieldForSchema(name, s)
  );
  const sibling = (name: string, kind: FieldKind) =>
    fields.find((f) => f.name === name && f.kind === kind)?.name;
  const fill: MediaFill = {
    ...(sibling("alt", "text") && { alt: "alt" }),
    ...(sibling("width", "number") && { width: "width" }),
    ...(sibling("height", "number") && { height: "height" }),
  };
  return fields.map((f) => (f.kind === "media" ? { ...f, fill } : f));
}

// ---------------------------------------------------------------------------------------------
// Values

/** A starting value for a new list item's field (required fields only; optional ones stay unset). */
export function defaultValue(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case "text":
      return spec.label;
    case "number":
      return spec.min ?? 0;
    case "boolean":
      return false;
    case "select":
      return spec.options[0]?.value;
    case "richText":
      return richTextFromString("Write something here.");
    case "link":
      return { label: "Learn more", href: "/contact" };
    case "object":
      return defaultObject(spec.fields);
    case "list":
      return Array.from({ length: spec.min ?? 0 }, () =>
        newListItem(spec.itemFields)
      );
    default:
      return;
  }
}

function defaultObject(fields: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.optional) {
      continue;
    }
    const v = defaultValue(f);
    if (v !== undefined) {
      out[f.name] = v;
    }
  }
  return out;
}

/** A new list item with a fresh `_key`. */
export function newListItem(itemFields: FieldSpec[]): Record<string, unknown> {
  return { _key: nanoid(8), ...defaultObject(itemFields) };
}

export type Path = (string | number)[];

/** `value` at `path` set immutably; `undefined` deletes an object key. */
export function setIn(target: unknown, path: Path, value: unknown): unknown {
  if (!path.length) {
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(target) && typeof head === "number") {
    return target.map((item, i) =>
      i === head ? setIn(item, rest, value) : item
    );
  }
  const obj =
    typeof target === "object" && target !== null
      ? { ...(target as Record<string, unknown>) }
      : {};
  const next = setIn(obj[head!], rest, value);
  if (next === undefined) {
    delete obj[head!];
  } else {
    obj[head!] = next;
  }
  return obj;
}

export function getIn(target: unknown, path: Path): unknown {
  let v = target;
  for (const k of path) {
    if (typeof v !== "object" || v === null) {
      return;
    }
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

/**
 * The `update` op props merge-patch that sets `path` to `value` in `props`: nested objects patch
 * only the changed key (`null` deletes), arrays are replaced wholesale (merge-patch can't address
 * array items).
 */
export function propsPatch(
  props: unknown,
  path: Path,
  value: unknown
): Record<string, unknown> {
  const [head, ...rest] = path;
  const key = String(head);
  if (!rest.length) {
    return { [key]: value === undefined ? null : value };
  }
  const current = getIn(props, [key]);
  if (Array.isArray(current)) {
    return { [key]: setIn(current, rest, value) };
  }
  return { [key]: propsPatch(current ?? {}, rest, value) };
}

/** One field to set: `value` at `path` in a block's props (`undefined` removes it). */
export type Change = { path: Path; value: unknown };

/** `props` with every change applied in order. */
export function setMany(props: unknown, changes: Change[]): unknown {
  return changes.reduce((p, c) => setIn(p, c.path, c.value), props);
}

/**
 * One `update` op props patch for several changes (e.g. an image pick that also sets alt, width
 * and height). Each change's patch is made against the props with the earlier changes applied, so
 * a list replaced wholesale by a later patch still holds the earlier changes.
 */
export function propsPatchMany(
  props: unknown,
  changes: Change[]
): Record<string, unknown> {
  let current = props;
  let patch: Record<string, unknown> = {};
  for (const c of changes) {
    patch = mergePatches(patch, propsPatch(current, c.path, c.value));
    current = setIn(current, c.path, c.value);
  }
  return patch;
}

function mergePatches(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] =
      isPatchObject(prev) && isPatchObject(v) ? mergePatches(prev, v) : v;
  }
  return out;
}

const isPatchObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the media library hands back for a picked image (MediaInfo's relevant fields). */
export type PickedMedia = {
  id: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
};

const textOf = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Whether the page's alt text is the library's alt text for `media` (so it describes that image, not the page's own words). */
const isLibraryAlt = (alt: unknown, media: PickedMedia | null) =>
  !!media?.alt?.trim() && textOf(alt) === media.alt.trim();

/**
 * The changes for picking `media` into the media field at `path`: its id, plus the fields named
 * by `fill` in the same object. `previous` is the library record of the image being replaced
 * (null when there was none, or it couldn't be loaded).
 * - Alt text: the new image's library alt when the page's alt is empty or is the previous image's
 *   library alt (it described that image); text the page wrote itself stays (see `altKeptOnReplace`).
 * - Width and height: the new image's (cleared when unknown) when unset or equal to the previous
 *   image's; dimensions set by hand stay.
 */
export function mediaPickChanges(
  props: unknown,
  path: Path,
  fill: MediaFill,
  media: PickedMedia,
  previous: PickedMedia | null = null
): Change[] {
  const parent = path.slice(0, -1);
  const changes: Change[] = [{ path, value: media.id }];
  const dim = (
    key: string | undefined,
    next: number | null | undefined,
    prev: number | null | undefined
  ) => {
    if (!key) {
      return;
    }
    const current = getIn(props, [...parent, key]);
    if (current === undefined || (prev != null && current === prev)) {
      changes.push({ path: [...parent, key], value: next ?? undefined });
    }
  };
  dim(fill.width, media.width, previous?.width);
  dim(fill.height, media.height, previous?.height);
  if (fill.alt) {
    const current = getIn(props, [...parent, fill.alt]);
    if (isLibraryAlt(current, previous)) {
      changes.push({
        path: [...parent, fill.alt],
        value: media.alt?.trim() ?? "",
      });
    } else if (!textOf(current) && media.alt) {
      changes.push({ path: [...parent, fill.alt], value: media.alt });
    }
  }
  return changes;
}

/**
 * Whether picking `media` over another image keeps alt text the page wrote for that image (the
 * editor then notes that it may describe the previous image).
 */
export function altKeptOnReplace(
  props: unknown,
  path: Path,
  fill: MediaFill,
  media: PickedMedia,
  previous: PickedMedia | null
): boolean {
  if (!fill.alt) {
    return false;
  }
  const before = getIn(props, path);
  if (typeof before !== "string" || !before || before === media.id) {
    return false;
  }
  const current = getIn(props, [...path.slice(0, -1), fill.alt]);
  return textOf(current) !== "" && !isLibraryAlt(current, previous);
}

/**
 * Removing the image: the id, and its width and height (they described that image). The alt text
 * is cleared only when it is `removed`'s library alt; text the page wrote itself stays.
 */
export function mediaRemoveChanges(
  props: unknown,
  path: Path,
  fill: MediaFill,
  removed: PickedMedia | null = null
): Change[] {
  const parent = path.slice(0, -1);
  return [
    { path, value: undefined },
    ...(fill.width
      ? [{ path: [...parent, fill.width], value: undefined }]
      : []),
    ...(fill.height
      ? [{ path: [...parent, fill.height], value: undefined }]
      : []),
    ...(fill.alt && isLibraryAlt(getIn(props, [...parent, fill.alt]), removed)
      ? [{ path: [...parent, fill.alt], value: "" }]
      : []),
  ];
}

/** `["items", 0, "title"]` → "items.0.title", the key the inspector files Zod issues under. */
export const pathKey = (path: Path) => path.join(".");
