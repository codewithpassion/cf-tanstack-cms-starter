import { z } from "zod";

import {
  type AnyBlockDef,
  getBlockDef,
  migrateProps,
  RETIRED_BLOCK_TYPES,
} from "./blocks/registry";
import { MAX_BLOCKS, MAX_DOC_BYTES } from "./limits";
import { isPostSlug } from "./posts";
import { pageSeoSchema, postMetaSchema } from "./seo/schema";
import { blockStyleSchema } from "./style/schema";
import type {
  Block,
  BlockStyle,
  ElementStyle,
  PageDoc,
  ValidationResult,
} from "./types";

export type ValidationError = { path: string; message: string };

const blockEnvelopeSchema = z.strictObject({
  _key: z.string().min(1).max(64),
  _type: z.string().min(1),
  _v: z.number().int().min(1),
  props: z.unknown(),
  style: z.unknown().optional(),
});

// biome-ignore lint/performance/noBarrelFile: callers import the limits with the validator, as in the source.
export { MAX_BLOCKS, MAX_DOC_BYTES } from "./limits";

const docEnvelopeSchema = z.strictObject({
  _schema: z.literal(1),
  seo: pageSeoSchema,
  post: postMetaSchema.optional(),
  chrome: z.enum(["site", "none"]).optional(),
  blocks: z
    .array(z.unknown())
    .max(MAX_BLOCKS, `A page can have at most ${MAX_BLOCKS} blocks`),
});

function join(path: string, key: PropertyKey): string {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }
  return path ? `${path}.${String(key)}` : String(key);
}

function pushIssues(
  errors: ValidationError[],
  error: z.ZodError,
  prefix: string
) {
  for (const issue of error.issues) {
    errors.push({
      path: issue.path.reduce<string>(join, prefix),
      message: issue.message,
    });
  }
}

export type ParsedBlock = {
  def?: AnyBlockDef;
  /** Set when props are valid (after migration). */
  props?: unknown;
  /** Set when style is valid; an invalid style is dropped. */
  style?: BlockStyle;
  /** The normalised block, when it can be rendered. */
  block?: Block;
  errors: ValidationError[];
};

/** Validates one block against the registry: envelope, migration, props schema, style schema and element names. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear pass over the envelope, props and style checks; kept as in the source.
export function parseBlock(raw: unknown, path = ""): ParsedBlock {
  const errors: ValidationError[] = [];
  const env = blockEnvelopeSchema.safeParse(raw);
  if (!env.success) {
    pushIssues(errors, env.error, path);
    return { errors };
  }
  const { _key, _type, _v } = env.data;

  const def = getBlockDef(_type);
  if (!def) {
    const retired = RETIRED_BLOCK_TYPES.includes(_type);
    errors.push({
      path: join(path, "_type"),
      message: `${retired ? "Retired" : "Unknown"} block type "${_type}"`,
    });
    return { errors };
  }

  let props: unknown;
  const migrated = migrateProps(def, _v, env.data.props);
  if (migrated.ok) {
    const result = def.schema.safeParse(migrated.props);
    if (result.success) {
      props = result.data;
    } else {
      pushIssues(errors, result.error, join(path, "props"));
    }
  } else {
    errors.push({ path: join(path, "_v"), message: migrated.message });
  }

  let style: BlockStyle | undefined;
  if (env.data.style !== undefined) {
    const result = blockStyleSchema.safeParse(env.data.style);
    if (result.success) {
      const before = errors.length;
      const elementsPath = join(join(path, "style"), "elements");
      for (const [name, el] of Object.entries(result.data.elements ?? {})) {
        const supported = Object.hasOwn(def.elements, name)
          ? def.elements[name]
          : undefined;
        if (!supported) {
          errors.push({
            path: `${elementsPath}.${name}`,
            message: `"${_type}" has no styleable element "${name}" (allowed: ${Object.keys(def.elements).join(", ")})`,
          });
          continue;
        }
        for (const prop of Object.keys(el) as (keyof ElementStyle)[]) {
          if (el[prop] === undefined || supported.includes(prop)) {
            continue;
          }
          errors.push({
            path: `${elementsPath}.${name}.${prop}`,
            message: `"${_type}" element "${name}" does not support "${prop}" (supported: ${supported.join(", ")})`,
          });
        }
      }
      if (errors.length === before) {
        style = result.data;
      }
    } else {
      pushIssues(errors, result.error, join(path, "style"));
    }
  }

  const block: Block | undefined =
    props === undefined
      ? undefined
      : { _key, _type, _v: def.version, props, ...(style ? { style } : {}) };
  return { def, props, style, block, errors };
}

const postSlugError: ValidationError = {
  path: "seo.slug",
  message: "A post's slug is blog/ and one more segment, like blog/my-post",
};

/** UTF-8 size of the serialised document. */
export function docBytes(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

/**
 * The page-wide limits the server enforces on every save, cheap enough to check per edit: block
 * count, serialised size, (with `seo`) the SEO settings and a post's slug, and (with `post`) a
 * post's metadata. Block contents are checked per block (`parseBlock`). Empty when the document is
 * within the limits.
 */
export function pageLimitErrors(
  doc: PageDoc,
  opts: { seo?: boolean; post?: boolean } = {}
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (doc.blocks.length > MAX_BLOCKS) {
    errors.push({
      path: "blocks",
      message: `A page can have at most ${MAX_BLOCKS} blocks`,
    });
  }
  const bytes = docBytes(doc);
  if (bytes > MAX_DOC_BYTES) {
    errors.push({
      path: "",
      message: `The page would be too large to save (${bytes} bytes; the limit is ${MAX_DOC_BYTES})`,
    });
  }
  if (opts.seo) {
    const seo = pageSeoSchema.safeParse(doc.seo);
    if (!seo.success) {
      pushIssues(errors, seo.error, "seo");
    } else if (doc.post && !isPostSlug(doc.seo.slug)) {
      errors.push(postSlugError);
    }
  }
  if (opts.post && doc.post) {
    const post = postMetaSchema.safeParse(doc.post);
    if (!post.success) {
      pushIssues(errors, post.error, "post");
    }
  }
  return errors;
}

/**
 * Validates a whole page document. On success returns the normalised doc (props migrated to the
 * current block versions). Error paths look like `blocks[2].props.items[0].title`. Never throws.
 */
export function validatePageDoc(doc: unknown): ValidationResult {
  try {
    return validateUnsafe(doc);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `Document could not be validated: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

function validateUnsafe(doc: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const top = docEnvelopeSchema.safeParse(doc);
  if (!top.success) {
    pushIssues(errors, top.error, "");
  }

  // Blocks are checked even when the envelope fails, so all errors are reported at once.
  const maybeBlocks =
    typeof doc === "object" && doc !== null
      ? (doc as { blocks?: unknown }).blocks
      : undefined;
  const rawBlocks: unknown[] =
    Array.isArray(maybeBlocks) && maybeBlocks.length <= MAX_BLOCKS
      ? maybeBlocks
      : [];
  const blocks: Block[] = [];
  const keys = new Set<string>();
  rawBlocks.forEach((raw, i) => {
    const path = `blocks[${i}]`;
    const parsed = parseBlock(raw, path);
    errors.push(...parsed.errors);
    if (!parsed.block) {
      return;
    }
    if (keys.has(parsed.block._key)) {
      errors.push({
        path: `${path}._key`,
        message: `Duplicate block _key "${parsed.block._key}"`,
      });
    }
    keys.add(parsed.block._key);
    blocks.push(parsed.block);
  });

  // A post lives at blog/<one segment> (posts.ts isPostSlug); checked on every save, not only at publish.
  if (top.success && top.data.post && !isPostSlug(top.data.seo.slug)) {
    errors.push(postSlugError);
  }

  if (errors.length || !top.success) {
    return { ok: false, errors };
  }
  const { seo, post, chrome } = top.data;
  const result: PageDoc = {
    _schema: 1,
    seo,
    ...(post ? { post } : {}),
    ...(chrome ? { chrome } : {}),
    blocks,
  };
  return { ok: true, doc: result };
}
