// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and this admin-only panel is not render-hot.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (op results), as in the source.

import {
  formatReadingTime,
  postWordCount,
  readingTimeOf,
} from "@repo/cms-core/posts";
import type { MergePatch, PostMeta } from "@repo/cms-core/types";
import { X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { getTrpc } from "#/integrations/trpc/client";
import { ImageField } from "./media-library";
import type { EditorStore } from "./store";
import { useEditorState, useEditorStore } from "./use-editor-store";

/**
 * A post's Post tab (docs/cms-plan.md §3.8): excerpt, author, dates, category, tags and featured
 * image. Every change is a `setPost` op (merge-patch; null clears), so post metadata has the same
 * drafts, undo and history as the blocks. Text commits after a pause in typing (or on blur, save,
 * publish). Reading time is computed from the body: shown here, stored by the server on save.
 */

type PostPatch = MergePatch<PostMeta>;

const COMMIT_AFTER_MS = 700;
const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 50;
/** The category select's "New category…" option (no real category is spelled like this). */
const NEW_CATEGORY = "__new__";

const inputClass =
  "w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none aria-[invalid=true]:border-destructive disabled:opacity-60";

type TextId =
  | "title"
  | "excerpt"
  | "author"
  | "category"
  | "imageAlt"
  | "readingTimeOverride";

const MAX_READING_MINUTES = 999;
const WHOLE_NUMBER_RE = /^\d+$/;

const TEXT: Record<
  TextId,
  {
    get: (p: PostMeta) => string;
    patch: (v: string) => PostPatch | null;
    validate?: (v: string) => string | null;
  }
> = {
  // Empty clears it: the post then shows its SEO title.
  title: {
    get: (p) => p.title ?? "",
    patch: (v) => ({ title: v.trim() || null }),
    validate: (v) => (v.trim().length > 200 ? "At most 200 characters." : null),
  },
  excerpt: { get: (p) => p.excerpt, patch: (v) => ({ excerpt: v }) },
  author: {
    get: (p) => p.author,
    patch: (v) => ({ author: v.trim() }),
    validate: (v) => (v.trim() ? null : "An author is required."),
  },
  category: {
    get: (p) => p.category,
    patch: (v) => ({ category: v.trim() }),
    validate: (v) => (v.trim() ? null : "A category is required."),
  },
  imageAlt: {
    get: (p) => p.featuredImage?.alt ?? "",
    patch: (v) => ({ featuredImage: { alt: v } }),
  },
  // Empty clears it: the computed reading time shows.
  readingTimeOverride: {
    get: (p) =>
      p.readingTimeOverride === undefined ? "" : String(p.readingTimeOverride),
    patch: (v) => ({ readingTimeOverride: v.trim() ? Number(v) : null }),
    validate: (v) =>
      !v.trim() ||
      (WHOLE_NUMBER_RE.test(v.trim()) &&
        Number(v) >= 1 &&
        Number(v) <= MAX_READING_MINUTES)
        ? null
        : `Whole minutes from 1 to ${MAX_READING_MINUTES}, or empty.`,
  },
};

function apply(store: EditorStore, patch: PostPatch): string | null {
  const res = store.apply([{ op: "setPost", post: patch }]);
  return res.ok
    ? null
    : (res.errors[0]?.message ?? "That change can't be saved.");
}

/** Typed-but-uncommitted text per field and its errors; committed after a pause, on blur, and before save/publish/undo. */
function useTextDrafts(store: EditorStore) {
  const [drafts, setDrafts] = useState<Partial<Record<TextId, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<TextId, string>>>({});
  const draftsRef = useRef(drafts);
  const timers = useRef(new Map<TextId, ReturnType<typeof setTimeout>>());

  const setDraft = (id: TextId, value: string | undefined) => {
    const next = { ...draftsRef.current };
    if (value === undefined) {
      delete next[id];
    } else {
      next[id] = value;
    }
    draftsRef.current = next;
    setDrafts(next);
  };
  const setError = (id: TextId, message: string | null) =>
    setErrors((e) => {
      const next = { ...e };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the store only, as in the source: it reads drafts through a ref, and setDraft/setError only touch that ref and state setters.
  const commit = useCallback(
    (id: TextId) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      const value = draftsRef.current[id];
      if (value === undefined) {
        return;
      }
      const post = store.getSnapshot().doc.post;
      if (!post) {
        return setDraft(id, undefined);
      }
      const field = TEXT[id];
      const invalid = field.validate?.(value);
      if (invalid) {
        return setError(id, invalid);
      }
      const patch = field.patch(value);
      if (!patch || value === field.get(post)) {
        setDraft(id, undefined);
        return setError(id, null);
      }
      const failed = apply(store, patch);
      if (failed) {
        return setError(id, failed);
      }
      setDraft(id, undefined);
      setError(id, null);
    },
    [store]
  );

  const change = (id: TextId, value: string) => {
    setDraft(id, value);
    setError(id, TEXT[id].validate?.(value) ?? null);
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => commit(id), COMMIT_AFTER_MS)
    );
  };

  useEffect(() => {
    const flushAll = () => {
      for (const id of Object.keys(draftsRef.current) as TextId[]) {
        commit(id);
      }
    };
    const unregister = store.registerFlusher(flushAll);
    return () => {
      unregister();
      flushAll();
    };
  }, [store, commit]);

  return { drafts, errors, change, commit };
}

/** Category names used by other posts, for the category picker (loaded once). */
function useKnownCategories(): string[] {
  const [categories, setCategories] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    getTrpc()
      .cms.posts.listPosts.query()
      .then((res) => {
        if (!cancelled && res.ok) {
          setCategories([
            ...new Set(res.posts.map((p) => p.category).filter(Boolean)),
          ]);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return categories;
}

export function PostPanel() {
  const store = useEditorStore();
  const { doc, pageStatus } = useEditorState();
  const readOnly = pageStatus === "archived";
  const fields = useTextDrafts(store);
  const known = useKnownCategories();
  const post = doc.post;
  const [newCategory, setNewCategory] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const words = useMemo(() => postWordCount(doc), [doc]);
  const minutes = useMemo(() => readingTimeOf(doc), [doc]);

  if (!post) {
    return (
      <p className="p-3 text-sm text-muted-foreground">
        This page isn't a post.
      </p>
    );
  }

  const applyNow = (patch: PostPatch) => {
    const failed = apply(store, patch);
    if (failed) {
      toast.error(failed);
    }
    return !failed;
  };
  /** Applies `patch`; the error message when it can't be (shown by the field). */
  const tryApply = (patch: PostPatch): string | null => apply(store, patch);
  const bind = (id: TextId) => ({
    value: fields.drafts[id] ?? TEXT[id].get(post),
    error: fields.errors[id] ?? null,
    onChange: (v: string) => fields.change(id, v),
    onBlur: () => fields.commit(id),
    testId: `post-${id}`,
  });

  const categories = [
    ...new Set([post.category, ...known].filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const addTags = (raw: string) => {
    const incoming = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!incoming.length) {
      return;
    }
    const tooLong = incoming.find((t) => t.length > MAX_TAG_LENGTH);
    if (tooLong) {
      return toast.error(`Tags can be at most ${MAX_TAG_LENGTH} characters.`);
    }
    const tags = [...post.tags];
    for (const t of incoming) {
      if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
        tags.push(t);
      }
    }
    if (tags.length > MAX_TAGS) {
      return toast.error(`A post can have at most ${MAX_TAGS} tags.`);
    }
    if (applyNow({ tags })) {
      setTagInput("");
    }
  };

  return (
    <div className="h-full overflow-y-auto px-3 pb-6" data-testid="post-panel">
      <fieldset
        disabled={readOnly}
        className="flex min-w-0 flex-col gap-5 pt-3"
      >
        {readOnly && (
          <p className="text-xs text-muted-foreground">
            Archived posts are read-only.
          </p>
        )}
        <Section title="Listing">
          <TextField
            label="Title"
            placeholder={doc.seo.title}
            hint="The post's heading, and its title on /blog, in post lists and in llms.txt. Empty: the SEO title."
            {...bind("title")}
          />
          <TextField
            label="Excerpt"
            multiline
            rows={4}
            hint="Shown on /blog and in post lists."
            {...bind("excerpt")}
          />
          <div className="flex flex-col gap-1">
            <label
              htmlFor="post-category"
              className="text-xs font-medium text-muted-foreground"
            >
              Category
            </label>
            {newCategory ? (
              <div className="flex gap-2">
                <input
                  id="post-category"
                  autoFocus
                  placeholder="New category"
                  maxLength={100}
                  className={inputClass}
                  aria-invalid={!!fields.errors.category}
                  value={fields.drafts.category ?? ""}
                  onChange={(e) => fields.change("category", e.target.value)}
                  onBlur={() => {
                    const typed = fields.drafts.category?.trim();
                    fields.commit("category");
                    if (typed) {
                      setNewCategory(false);
                    }
                  }}
                  data-testid="post-category-new"
                />
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setNewCategory(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <select
                id="post-category"
                className={inputClass}
                value={post.category}
                onChange={(e) => {
                  if (e.target.value === NEW_CATEGORY) {
                    return setNewCategory(true);
                  }
                  applyNow({ category: e.target.value });
                }}
                data-testid="post-category"
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value={NEW_CATEGORY}>New category…</option>
              </select>
            )}
            {!!fields.errors.category && (
              <p className="text-xs text-destructive">
                {fields.errors.category}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="post-tag-input"
              className="text-xs font-medium text-muted-foreground"
            >
              Tags
            </label>
            <div className="flex flex-wrap gap-1.5" data-testid="post-tags">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 text-xs"
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      applyNow({ tags: post.tags.filter((t) => t !== tag) })
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <input
              id="post-tag-input"
              className={inputClass}
              placeholder="Add a tag, then Enter (commas add several)"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTags(tagInput);
                }
              }}
              onBlur={() => addTags(tagInput)}
              data-testid="post-tag-input"
            />
            <p className="text-xs text-muted-foreground">
              Shown under the post, linked to /blog?tag=…, and used as the
              article's keywords.
            </p>
          </div>
        </Section>

        <Section title="Byline">
          <TextField label="Author" {...bind("author")} />
          <DateField
            label="Published"
            hint={
              post.publishedAtAuto
                ? "Set to the day it's first published, unless you change it."
                : undefined
            }
            value={post.publishedAt.slice(0, 10)}
            // Setting the date by hand keeps it: the first publish no longer re-dates the post.
            onCommit={(v) =>
              v
                ? tryApply({ publishedAt: v, publishedAtAuto: null })
                : "A published date is required."
            }
            testId="post-published"
          />
          <DateField
            label="Updated"
            optional
            hint="For the article's dateModified; the published date when empty."
            value={post.modifiedAt?.slice(0, 10) ?? ""}
            onCommit={(v) => tryApply({ modifiedAt: v || null })}
            testId="post-modified"
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Reading time
            </span>
            <p
              className="text-sm text-foreground"
              data-testid="post-reading-time"
            >
              {minutes ? formatReadingTime(minutes) : "—"}{" "}
              <span className="text-xs text-muted-foreground">
                ({words} words; computed from the text)
              </span>
            </p>
          </div>
          <TextField
            label="Reading time shown (minutes)"
            placeholder={minutes ? String(minutes) : ""}
            hint={
              post.readingTimeOverride === undefined
                ? "Empty: the computed time is shown."
                : `Shown instead of the computed ${formatReadingTime(minutes) || "time"}. Empty it to show the computed time.`
            }
            {...bind("readingTimeOverride")}
          />
        </Section>

        <Section title="Featured image">
          <div data-testid="post-featured-image">
            <ImageField
              label=""
              value={post.featuredImage}
              onChange={(v) =>
                applyNow({
                  featuredImage: v ? { mediaId: v.mediaId, alt: v.alt } : null,
                })
              }
            />
          </div>
          {!!post.featuredImage && (
            <TextField label="Alt text" {...bind("imageAlt")} />
          )}
          <p className="text-xs text-muted-foreground">
            Shown under the title, and as the article's image in search results.
          </p>
        </Section>
      </fieldset>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function TextField({
  label,
  value,
  error,
  onChange,
  onBlur,
  testId,
  multiline,
  rows,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onBlur: () => void;
  testId: string;
  multiline?: boolean;
  rows?: number;
  hint?: string;
  placeholder?: string;
}) {
  const props = {
    id: testId,
    value,
    placeholder,
    "aria-invalid": !!error,
    "data-testid": testId,
    className: inputClass,
    onBlur,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={testId}
        className="text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {multiline ? <textarea rows={rows} {...props} /> : <input {...props} />}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * A date input that commits on blur or Enter, not on every change: typing a year passes through
 * dates like 0002-07-12, which would each become an edit. `onCommit` returns an error to show, or
 * null. Escape puts the committed value back.
 */
function DateField({
  label,
  value,
  onCommit,
  testId,
  optional,
  hint,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => string | null;
  testId: string;
  optional?: boolean;
  hint?: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    if (typed === null) {
      return;
    }
    if (typed === value) {
      setTyped(null);
      return setError(null);
    }
    const failed = onCommit(typed);
    setError(failed);
    if (!failed) {
      setTyped(null);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={testId}
        className="text-xs font-medium text-muted-foreground"
      >
        {label}
        {!!optional && (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        )}
      </label>
      <input
        type="date"
        id={testId}
        data-testid={testId}
        className={inputClass}
        aria-invalid={!!error}
        value={typed ?? value}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setTyped(null);
            setError(null);
          }
        }}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
