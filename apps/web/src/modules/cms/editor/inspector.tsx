// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only, no runtime change.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: intentional no-op callbacks, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.

import {
  altKeptOnReplace,
  type Change,
  defaultValue,
  type FieldSpec,
  fieldsForSchema,
  mediaPickChanges,
  mediaRemoveChanges,
  newListItem,
  type Path,
  type PickedMedia,
  pathKey,
  propsPatchMany,
  setMany,
} from "@repo/cms-core/editor/inspector-fields";
import type { RichTextDoc } from "@repo/cms-core/richtext/schema";
import type { Block, Device } from "@repo/cms-core/types";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Switch } from "#/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import { getBlock } from "../blocks/registry";
import { ImageField, type MediaInfo } from "./media-library";
import { RichTextEditor } from "./rich-text-editor";
import { StylePanel } from "./style-panel";
import { useEditorState, useEditorStore } from "./use-editor-store";

/**
 * Right panel. "Content" is generated from the selected block's schema (inspector-fields.ts);
 * "Style" edits the block's style for the editor's current `device` (style-panel.tsx).
 */
export function Inspector({ device }: { device: Device }) {
  const { doc, selectedKey, pageStatus } = useEditorState();
  const block = selectedKey
    ? doc.blocks.find((b) => b._key === selectedKey)
    : undefined;
  const readOnly = pageStatus === "archived";
  return (
    <Tabs
      defaultValue="content"
      className="flex h-full flex-col"
      data-testid="inspector"
    >
      <TabsList className="m-2 grid grid-cols-2 bg-muted">
        <TabsTrigger value="content">Content</TabsTrigger>
        <TabsTrigger value="style" data-testid="tab-style">
          Style
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="content"
        className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-6"
      >
        {block ? (
          // A disabled fieldset disables every input, select and button inside; rich text checks pageStatus itself.
          <fieldset
            disabled={readOnly}
            className="min-w-0"
            data-testid="inspector-fieldset"
          >
            {readOnly && (
              <p className="pt-2 text-xs text-muted-foreground">
                Archived pages are read-only.
              </p>
            )}
            <BlockContentForm key={block._key} block={block} />
          </fieldset>
        ) : (
          <p className="p-2 text-sm text-muted-foreground">
            Select a block on the canvas or in Layers to edit its content.
          </p>
        )}
      </TabsContent>
      <TabsContent
        value="style"
        className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-6"
      >
        {block ? (
          <fieldset disabled={readOnly} className="min-w-0">
            {readOnly && (
              <p className="pt-2 text-xs text-muted-foreground">
                Archived pages are read-only.
              </p>
            )}
            <StylePanel key={block._key} block={block} device={device} />
          </fieldset>
        ) : (
          <p className="p-2 text-sm text-muted-foreground">
            Select a block on the canvas or in Layers to style it.
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Validates against the block schema and applies; returns the error to show at this field, or null. */
type Commit = (path: Path, value: unknown) => string | null;

/**
 * Like `Commit`, for several fields in one undo step: `build` gets the block's latest props and
 * returns the changes; the first change's path is where an error is filed.
 */
type CommitChanges = (build: (props: unknown) => Change[]) => string | null;

function BlockContentForm({ block }: { block: Block }) {
  const store = useEditorStore();
  const def = getBlock(block._type);
  const fields = useMemo(() => (def ? fieldsForSchema(def.schema) : []), [def]);
  const registerFlusher = useCallback(
    (fn: () => void) => store.registerFlusher(fn),
    [store]
  );

  const commitChanges: CommitChanges = useCallback(
    (build) => {
      if (!def) {
        return "Unknown block type";
      }
      // Always the latest props, not the ones this render closed over.
      const current = store
        .getSnapshot()
        .doc.blocks.find((b) => b._key === block._key);
      if (!current) {
        return "This block was removed";
      }
      const changes = build(current.props);
      if (!changes.length) {
        return null;
      }
      const path = changes[0]!.path;
      const candidate = setMany(current.props, changes);
      const parsed = def.schema.safeParse(candidate);
      if (!parsed.success) {
        const here = pathKey(path);
        const issue =
          parsed.error.issues.find((i: { path: PropertyKey[] }) =>
            pathKey(i.path as Path).startsWith(here)
          ) ?? parsed.error.issues[0];
        const at = pathKey(issue.path as Path);
        const message = friendlyIssue(issue);
        return at.startsWith(here) ? message : `${at}: ${message}`;
      }
      const res = store.apply([
        {
          op: "update",
          key: block._key,
          props: propsPatchMany(current.props, changes),
        },
      ]);
      return res.ok
        ? null
        : (res.errors[0]?.message ?? "That change couldn't be made");
    },
    [def, store, block._key]
  );
  const commit: Commit = useCallback(
    (path, value) => commitChanges(() => [{ path, value }]),
    [commitChanges]
  );

  if (!def) {
    return (
      <p className="p-2 text-sm text-destructive">
        Unknown block type "{block._type}".
      </p>
    );
  }
  const props = (block.props ?? {}) as Record<string, unknown>;
  return (
    <div
      className="flex flex-col gap-4 pt-2"
      data-testid="content-form"
      data-block={block._type}
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <def.Icon className="h-4 w-4 text-primary" /> {def.label}
      </div>
      {fields.map((spec) => (
        <FieldControl
          key={spec.name}
          spec={spec}
          path={[spec.name]}
          value={props[spec.name]}
          parent={props}
          commit={commit}
          commitChanges={commitChanges}
          registerFlusher={registerFlusher}
        />
      ))}
    </div>
  );
}

/** Zod's wording for the common cases is technical ("Too small: expected string to have >=1 characters"). */
function friendlyIssue(issue: {
  code?: string;
  message: string;
  minimum?: unknown;
  maximum?: unknown;
  origin?: string;
}): string {
  if (issue.origin === "string" && issue.code === "too_small") {
    return issue.minimum === 1
      ? "Can't be empty"
      : `Use at least ${String(issue.minimum)} characters`;
  }
  if (issue.origin === "string" && issue.code === "too_big") {
    return `Use at most ${String(issue.maximum)} characters`;
  }
  if (issue.origin === "array" && issue.code === "too_small") {
    return `Keep at least ${String(issue.minimum)}`;
  }
  if (issue.origin === "array" && issue.code === "too_big") {
    return `At most ${String(issue.maximum)} allowed`;
  }
  return issue.message;
}

type ControlProps = {
  spec: FieldSpec;
  path: Path;
  value: unknown;
  /** The object holding this field (the block's props, a list item, a nested object). */
  parent: Record<string, unknown>;
  commit: Commit;
  commitChanges: CommitChanges;
  registerFlusher: (fn: () => void) => () => void;
};

function FieldControl(props: ControlProps) {
  switch (props.spec.kind) {
    case "text":
      return <TextField {...props} />;
    case "media":
      return <MediaField {...props} />;
    case "number":
      return <NumberField {...props} />;
    case "boolean":
      return <BooleanField {...props} />;
    case "select":
      return <SelectField {...props} />;
    case "richText":
      return <RichTextField {...props} />;
    case "link":
      return <LinkField {...props} />;
    case "object":
      return <ObjectField {...props} />;
    case "list":
      return <ListField {...props} />;
    default:
      return (
        <FieldShell label={props.spec.label}>
          <pre className="overflow-x-auto rounded bg-background p-2 text-xs text-muted-foreground">
            {JSON.stringify(props.value, null, 2)}
          </pre>
        </FieldShell>
      );
  }
}

const inputClass =
  "w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none aria-[invalid=true]:border-destructive";

function FieldShell({
  label,
  htmlFor,
  error,
  hint,
  optional,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | null;
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-muted-foreground"
      >
        {label}
        {!!optional && (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        )}
      </label>
      {children}
      {!!hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {!!error && (
        <p
          className="text-xs text-destructive"
          role="alert"
          data-testid="field-error"
        >
          {error}
          <span className="block text-muted-foreground">
            Not applied: the page keeps the last valid value.
          </span>
        </p>
      )}
    </div>
  );
}

/** Local text that follows the stored value, except while it holds an invalid edit. */
function useLocal<T>(
  value: T
): [T, (v: T) => void, string | null, (e: string | null) => void] {
  const [local, setLocal] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLocal(value);
    setError(null);
  }, [value]);
  return [local, setLocal, error, setError];
}

function TextField({ spec, path, value, commit }: ControlProps) {
  const [local, setLocal, error, setError] = useLocal(
    typeof value === "string" ? value : ""
  );
  const id = `f-${pathKey(path)}`;
  const multiline = spec.kind === "text" && spec.multiline;
  const onChange = (v: string) => {
    setLocal(v);
    setError(commit(path, v === "" && spec.optional ? undefined : v));
  };
  const common = {
    id,
    value: local,
    "aria-invalid": error ? true : undefined,
    "data-testid": `field-${pathKey(path)}`,
    className: inputClass,
    maxLength: spec.kind === "text" ? spec.maxLength : undefined,
  };
  return (
    <FieldShell
      label={spec.label}
      htmlFor={id}
      error={error}
      optional={spec.optional}
    >
      {multiline ? (
        <textarea
          rows={3}
          {...common}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          {...common}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FieldShell>
  );
}

/**
 * A media id field: thumbnail, choose/replace from the media library, remove. Picking also fills
 * the sibling alt, width and height the schema has (inspector-fields.ts `mediaPickChanges`, which
 * compares them with the current image's library record, loaded here).
 */
function MediaField({
  spec,
  path,
  value,
  parent,
  commitChanges,
}: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  const mediaId = typeof value === "string" && value ? value : undefined;
  // The current image's library record; `media: null` when the library has no such image.
  const [library, setLibrary] = useState<{
    id: string;
    media: MediaInfo | null;
  } | null>(null);
  // Alt text kept when the image was replaced; the note shows while the alt is still that text.
  const [keptAlt, setKeptAlt] = useState<string | null>(null);

  useEffect(() => {
    if (!mediaId || library?.id === mediaId) {
      return;
    }
    let cancelled = false;
    getTrpc()
      .cms.media.getMediaInfo.query({ id: mediaId })
      .then((media) => !cancelled && setLibrary({ id: mediaId, media }))
      .catch(() => {}); // Unknown: picks then only fill empty fields.
    return () => {
      cancelled = true;
    };
  }, [mediaId, library?.id]);

  if (spec.kind !== "media") {
    return null;
  }
  const { fill } = spec;
  const alt =
    fill.alt && typeof parent[fill.alt] === "string"
      ? (parent[fill.alt] as string)
      : "";
  const recordOf = async (id: string): Promise<PickedMedia | null> =>
    library?.id === id
      ? library.media
      : getTrpc()
          .cms.media.getMediaInfo.query({ id })
          .catch(() => null);

  const pick = async (media: MediaInfo) => {
    const previous = mediaId ? await recordOf(mediaId) : null;
    let kept = false;
    const err = commitChanges((props) => {
      kept = altKeptOnReplace(props, path, fill, media, previous);
      return mediaPickChanges(props, path, fill, media, previous);
    });
    setError(err);
    if (!err) {
      setLibrary({ id: media.id, media });
      setKeptAlt(kept ? alt : null);
    }
  };
  const remove = async () => {
    const removed = mediaId ? await recordOf(mediaId) : null;
    setError(
      commitChanges((props) => mediaRemoveChanges(props, path, fill, removed))
    );
    setKeptAlt(null);
  };

  return (
    <FieldShell label={spec.label} error={error} optional={spec.optional}>
      <div data-testid={`field-${pathKey(path)}`}>
        <ImageField
          label=""
          value={mediaId ? { mediaId, alt } : undefined}
          altNote={
            fill.alt
              ? undefined
              : "This block sets the image's alt text itself."
          }
          removable={spec.optional}
          onPick={(media) => void pick(media)}
          onRemove={() => void remove()}
        />
        {mediaId && library?.id === mediaId && library.media === null && (
          <p
            className="mt-1 text-xs text-amber-700 dark:text-amber-300"
            data-testid="image-missing"
          >
            This image isn't in the media library any more; pick another.
          </p>
        )}
        {keptAlt !== null && mediaId && alt === keptAlt && (
          <p
            className="mt-1 text-xs text-amber-700 dark:text-amber-300"
            data-testid="image-alt-kept"
          >
            Alt text may describe the previous image.
          </p>
        )}
      </div>
    </FieldShell>
  );
}

function NumberField({ spec, path, value, commit }: ControlProps) {
  const [local, setLocal, error, setError] = useLocal(
    typeof value === "number" ? String(value) : ""
  );
  const id = `f-${pathKey(path)}`;
  const range = spec.kind === "number" ? spec : undefined;
  return (
    <FieldShell
      label={spec.label}
      htmlFor={id}
      error={error}
      optional={spec.optional}
    >
      <input
        id={id}
        type="number"
        className={inputClass}
        value={local}
        min={range?.min}
        max={range?.max}
        step={range?.integer ? 1 : "any"}
        aria-invalid={error ? true : undefined}
        data-testid={`field-${pathKey(path)}`}
        onChange={(e) => {
          const raw = e.target.value;
          setLocal(raw);
          if (raw === "") {
            return setError(
              spec.optional ? commit(path, undefined) : "Required"
            );
          }
          const n = Number(raw);
          setError(Number.isFinite(n) ? commit(path, n) : "Enter a number");
        }}
      />
    </FieldShell>
  );
}

function BooleanField({ spec, path, value, commit }: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <FieldShell label={spec.label} error={error}>
      <Switch
        checked={value === true}
        data-testid={`field-${pathKey(path)}`}
        onCheckedChange={(checked) => setError(commit(path, checked))}
      />
    </FieldShell>
  );
}

function SelectField({ spec, path, value, commit }: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  if (spec.kind !== "select") {
    return null;
  }
  const id = `f-${pathKey(path)}`;
  const current = spec.options.findIndex((o) => o.value === value);
  return (
    <FieldShell
      label={spec.label}
      htmlFor={id}
      error={error}
      optional={spec.optional}
    >
      <select
        id={id}
        className={inputClass}
        value={current < 0 ? "" : String(current)}
        data-testid={`field-${pathKey(path)}`}
        onChange={(e) => {
          const i = e.target.value === "" ? -1 : Number(e.target.value);
          setError(commit(path, i < 0 ? undefined : spec.options[i]!.value));
        }}
      >
        {(spec.optional || current < 0) && (
          <option value="">{spec.optional ? "None" : "Choose…"}</option>
        )}
        {spec.options.map((o, i) => (
          <option key={String(o.value)} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function RichTextField({
  spec,
  path,
  value,
  commit,
  registerFlusher,
}: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  const { pageStatus } = useEditorState();
  return (
    <FieldShell label={spec.label} error={error} optional={spec.optional}>
      <RichTextEditor
        value={value as RichTextDoc}
        toolbar="static"
        editable={pageStatus !== "archived"}
        className="flex flex-col gap-1 rounded border border-border bg-background p-2 text-sm text-foreground [&_.ProseMirror]:min-h-16"
        registerFlusher={registerFlusher}
        onInvalid={setError}
        onChange={(doc) => setError(commit(path, doc))}
        data-testid={`field-${pathKey(path)}`}
      />
    </FieldShell>
  );
}

function LinkField({
  spec,
  path,
  value,
  commit,
  commitChanges,
  registerFlusher,
}: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  if (value === undefined || value === null) {
    return (
      <FieldShell label={spec.label} error={error} optional={spec.optional}>
        <button
          type="button"
          className="flex w-fit items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary"
          data-testid={`add-${pathKey(path)}`}
          onClick={() => setError(commit(path, defaultValue(spec)))}
        >
          <Plus className="h-3.5 w-3.5" /> Add {spec.label.toLowerCase()} button
        </button>
      </FieldShell>
    );
  }
  const link = value as { label?: string; href?: string } & Record<
    string,
    unknown
  >;
  const sub = (name: "label" | "href", label: string): FieldSpec => ({
    kind: "text",
    name,
    label,
    optional: false,
    multiline: false,
  });
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-border p-2">
      <legend className="flex w-full items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        {spec.label} button
        {!!spec.optional && (
          <button
            type="button"
            className="ml-2 text-muted-foreground hover:text-destructive"
            onClick={() => setError(commit(path, undefined))}
            aria-label={`Remove ${spec.label.toLowerCase()} button`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </legend>
      {(["label", "href"] as const).map((name) => (
        <TextField
          key={name}
          spec={sub(name, name === "label" ? "Label" : "Link")}
          path={[...path, name]}
          value={link[name]}
          parent={link}
          commit={commit}
          commitChanges={commitChanges}
          registerFlusher={registerFlusher}
        />
      ))}
      {!!error && <p className="text-xs text-destructive">{error}</p>}
    </fieldset>
  );
}

function ObjectField({
  spec,
  path,
  value,
  commit,
  commitChanges,
  registerFlusher,
}: ControlProps) {
  if (spec.kind !== "object") {
    return null;
  }
  const obj = (value ?? {}) as Record<string, unknown>;
  return (
    <fieldset className="flex flex-col gap-3 rounded border border-border p-2">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        {spec.label}
      </legend>
      {spec.fields.map((f) => (
        <FieldControl
          key={f.name}
          spec={f}
          path={[...path, f.name]}
          value={obj[f.name]}
          parent={obj}
          commit={commit}
          commitChanges={commitChanges}
          registerFlusher={registerFlusher}
        />
      ))}
    </fieldset>
  );
}

function ListField({
  spec,
  path,
  value,
  commit,
  commitChanges,
  registerFlusher,
}: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (spec.kind !== "list") {
    return null;
  }
  const items = (Array.isArray(value) ? value : []) as Record<
    string,
    unknown
  >[];
  const canAdd = spec.max === undefined || items.length < spec.max;
  const canRemove = spec.min === undefined || items.length > spec.min;
  const set = (next: unknown[]) => setError(commit(path, next));
  const move = (i: number, delta: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
    set(next);
  };
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  return (
    <div className="flex flex-col gap-2" data-testid={`list-${pathKey(path)}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {spec.label}{" "}
          <span className="text-muted-foreground">({items.length})</span>
        </span>
        <button
          type="button"
          disabled={!canAdd}
          data-testid={`add-item-${pathKey(path)}`}
          onClick={() => {
            const item = newListItem(spec.itemFields);
            setOpen((s) => new Set(s).add(String(item._key)));
            set([...items, item]);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-primary hover:bg-muted disabled:opacity-30"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      {items.map((item, i) => {
        const key = String(item._key ?? i);
        const title =
          (spec.itemLabelField &&
            typeof item[spec.itemLabelField] === "string" &&
            (item[spec.itemLabelField] as string)) ||
          `Item ${i + 1}`;
        const expanded = open.has(key);
        return (
          <div
            key={key}
            className="rounded border border-border"
            data-testid="list-item"
          >
            <div className="flex items-center gap-1 px-2 py-1">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
                onClick={() => toggle(key)}
                aria-expanded={expanded}
              >
                {expanded ? "▾" : "▸"} {title}
              </button>
              <IconButton
                label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label="Move down"
                disabled={i === items.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label="Remove"
                disabled={!canRemove}
                onClick={() => set(items.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            {expanded && (
              <div className="flex flex-col gap-3 border-t border-border p-2">
                {spec.itemFields.map((f) => (
                  <FieldControl
                    key={f.name}
                    spec={f}
                    path={[...path, i, f.name]}
                    value={item[f.name]}
                    parent={item}
                    commit={commit}
                    commitChanges={commitChanges}
                    registerFlusher={registerFlusher}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!!error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}
