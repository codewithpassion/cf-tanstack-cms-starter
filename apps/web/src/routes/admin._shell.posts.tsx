// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source admin; inline handlers keep it diffable and this admin-only page is not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; the slug status text is kept as in the source.
import type { PageStatus } from "@repo/cms-core/admin-result";
import { formatDateTime } from "@repo/cms-core/format-date";
import { isValidSlug, slugToPath } from "@repo/cms-core/paths";
import { formatPostDate } from "@repo/cms-core/posts";
import type { PostListItem } from "@repo/services/cms/posts-admin";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  goToLogin,
  isUnauthorized,
  redirectOnUnauthorized,
} from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import {
  UnpublishDialog,
  type UnpublishTarget,
} from "#/modules/cms/editor/unpublish-dialog";

/**
 * Blog posts (docs/cms-plan.md §3.8): every post with status, category and date filters, and "New
 * post". A published post shows its live title, category and date, flagged when its draft has
 * unpublished changes.
 */
export const Route = createFileRoute("/admin/_shell/posts")({
  head: () => ({ meta: [{ title: "Posts | Admin" }] }),
  loader: ({ location }) =>
    redirectOnUnauthorized(
      getTrpc().cms.posts.listPosts.query(),
      location.href
    ),
  component: PostsPage,
});

const selectClass =
  "h-9 rounded-md border border-neutral-700 bg-neutral-950 px-2 text-sm text-neutral-100";

function PostsPage() {
  const result = Route.useLoaderData();
  const [open, setOpen] = useState(false);
  const posts = result.ok ? result.posts : [];

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold font-heading text-2xl">Posts</h1>
        <Button data-testid="new-post" onClick={() => setOpen(true)}>
          <Plus /> New post
        </Button>
      </div>
      {result.ok ? (
        <PostsTable posts={posts} />
      ) : (
        <p className="text-danger">{result.message}</p>
      )}
      <NewPostDialog onOpenChange={setOpen} open={open} posts={posts} />
    </div>
  );
}

/** A failed call's message, or null after sending a signed-out admin to sign in. */
const failureText = (err: unknown): string | null => {
  if (isUnauthorized(err)) {
    goToLogin(window.location.pathname + window.location.search);
    return null;
  }
  return err instanceof Error ? err.message : String(err);
};

const STATUS_CLASS: Record<PageStatus, string> = {
  draft: "bg-neutral-700 text-neutral-200",
  published: "bg-emerald-700/60 text-emerald-100",
  archived: "bg-neutral-800 text-neutral-500",
};

/** Each category once, sorted. */
function categoriesOf(posts: readonly PostListItem[]): string[] {
  return [...new Set(posts.map((p) => p.category).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
}

function PostsTable({ posts }: { posts: PostListItem[] }) {
  const router = useRouter();
  const [unpublishing, setUnpublishing] = useState<UnpublishTarget | null>(
    null
  );
  const invalidate = useCallback(() => router.invalidate(), [router]);
  const closeUnpublish = useCallback(() => setUnpublishing(null), []);
  const [status, setStatus] = useState<"" | PageStatus>("");
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const categories = useMemo(() => categoriesOf(posts), [posts]);
  // Dates compare as YYYY-MM-DD (an ISO timestamp's first 10 characters).
  const shown = posts.filter((p) => {
    const day = p.publishedAt.slice(0, 10);
    return (
      (!status || p.status === status) &&
      (!category || p.category === category) &&
      (!from || day >= from) &&
      (!to || day <= to)
    );
  });

  if (!posts.length) {
    return (
      <p className="text-neutral-400">No posts yet. Write the first one.</p>
    );
  }
  return (
    <>
      <div
        className="mb-4 flex flex-wrap items-end gap-4 text-sm"
        data-testid="posts-filters"
      >
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400 text-xs">Status</span>
          <select
            className={selectClass}
            data-testid="posts-filter-status"
            onChange={(e) => setStatus(e.target.value as "" | PageStatus)}
            value={status}
          >
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400 text-xs">Category</span>
          <select
            className={selectClass}
            data-testid="posts-filter-category"
            onChange={(e) => setCategory(e.target.value)}
            value={category}
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400 text-xs">Published from</span>
          <input
            className={selectClass}
            data-testid="posts-filter-from"
            onChange={(e) => setFrom(e.target.value)}
            type="date"
            value={from}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400 text-xs">to</span>
          <input
            className={selectClass}
            data-testid="posts-filter-to"
            onChange={(e) => setTo(e.target.value)}
            type="date"
            value={to}
          />
        </label>
        <span className="pb-2 text-neutral-500 text-xs">
          {shown.length} of {posts.length}
        </span>
      </div>
      <div className="relative overflow-x-auto rounded border border-neutral-800">
        {/* The body's `[overflow-wrap:anywhere]` (__root.tsx) breaks short words mid-word in table cells. */}
        <table
          className="w-full text-left text-sm [overflow-wrap:normal]"
          data-testid="posts-table"
        >
          <thead className="bg-neutral-900 text-neutral-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Updated</th>
              <th className="px-4 py-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr
                className="border-neutral-800 border-t hover:bg-neutral-900"
                key={p.id}
              >
                <td className="px-4 py-3">
                  <Link
                    className="font-medium text-white hover:text-accent"
                    params={{ pageId: p.id }}
                    to="/admin/editor/$pageId"
                  >
                    {p.title}
                  </Link>
                  <div className="font-mono text-neutral-500 text-xs">
                    {slugToPath(p.slug)}
                  </div>
                </td>
                <td className="px-4 py-3 text-neutral-300">{p.category}</td>
                <td className="px-4 py-3 text-neutral-300">
                  {p.publishedAt ? formatPostDate(p.publishedAt) : ""}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[p.status]}`}
                  >
                    {p.status}
                  </span>
                  {!!p.draftChanges && (
                    <span
                      className="ml-2 rounded bg-amber-500/20 px-2 py-0.5 text-amber-200 text-xs"
                      data-testid="post-draft-changes"
                      title="The draft has changes that aren't published yet; the title, category and date shown are the live ones."
                    >
                      unpublished changes
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-neutral-400">
                  {formatDateTime(p.updatedAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  {p.status === "published" && (
                    <Button
                      data-testid={`unpublish-${p.slug}`}
                      onClick={() =>
                        setUnpublishing({
                          id: p.id,
                          kind: "post",
                          path: slugToPath(p.slug),
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Unpublish
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <UnpublishDialog
        onClose={closeUnpublish}
        onDone={invalidate}
        target={unpublishing}
      />
    </>
  );
}

const COMBINING_MARKS_RE = /[̀-ͯ]/g;
const NON_SLUG_RE = /[^a-z0-9]+/g;
const EDGE_DASHES_RE = /^-+|-+$/g;
const TRAILING_DASHES_RE = /-+$/;

/** "My new post!" → "my-new-post". */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(NON_SLUG_RE, "-")
    .replace(EDGE_DASHES_RE, "")
    .slice(0, 80)
    .replace(TRAILING_DASHES_RE, "");
}

/** A server error for the new post's slug, with a taken slug named by its public path rather than the internal `blog/…` key. */
function slugError(
  res: { code: string; message: string },
  slug: string
): string {
  return res.code === "SLUG_TAKEN"
    ? `/blog/${slug} is already in use. Pick another path.`
    : res.message;
}

type SlugState =
  | { status: "idle" | "checking" | "ok" }
  | { status: "error"; message: string };

/** The category select's "New category…" option (no real category is spelled like this). */
const NEW_CATEGORY = "__new__";

function NewPostDialog({
  open,
  onOpenChange,
  posts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  posts: PostListItem[];
}) {
  const navigate = useNavigate();
  const categories = useMemo(() => categoriesOf(posts), [posts]);
  // The author of the most recently updated post, as a starting point.
  const lastAuthor = posts.find((p) => p.author)?.author ?? "";
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugState, setSlugState] = useState<SlugState>({ status: "idle" });
  const [categoryChoice, setCategoryChoice] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [author, setAuthor] = useState(lastAuthor);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setSlug("");
      setSlugEdited(false);
      setSlugState({ status: "idle" });
      setCategoryChoice(categories[0] ?? NEW_CATEGORY);
      setNewCategory("");
      setAuthor(lastAuthor);
      setError(null);
    }
  }, [open, categories, lastAuthor]);

  // Format first (no round trip), then the server's rules (taken slugs).
  useEffect(() => {
    if (!slug) {
      return setSlugState({ status: "idle" });
    }
    if (!isValidSlug(slug) || slug.includes("/")) {
      return setSlugState({
        status: "error",
        message: "Use lowercase words separated by -, e.g. ai-for-accountants",
      });
    }
    setSlugState({ status: "checking" });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await getTrpc().cms.posts.checkPostSlug.query({ slug });
        if (!cancelled) {
          setSlugState(
            res.ok
              ? { status: "ok" }
              : { status: "error", message: slugError(res, slug) }
          );
        }
      } catch (err) {
        const message = failureText(err);
        if (!cancelled && message !== null) {
          setSlugState({ status: "error", message });
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [slug]);

  const category = (
    categoryChoice === NEW_CATEGORY ? newCategory : categoryChoice
  ).trim();
  const canSubmit =
    title.trim() !== "" &&
    slugState.status === "ok" &&
    category !== "" &&
    author.trim() !== "" &&
    !submitting;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await getTrpc().cms.posts.createPost.mutate({
        title: title.trim(),
        slug,
        category,
        author: author.trim(),
      });
      if (!res.ok) {
        setError(slugError(res, slug));
        return;
      }
      onOpenChange(false);
      await navigate({
        to: "/admin/editor/$pageId",
        params: { pageId: res.id },
      });
    } catch (err) {
      const message = failureText(err);
      if (message !== null) {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/* `sm:max-w-md`: this repo's shadcn DialogContent sets `sm:max-w-sm`, which beats a plain max-w. */}
      <DialogContent className="max-w-md border-neutral-700 bg-neutral-900 text-neutral-100 sm:max-w-md">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New post</DialogTitle>
            <DialogDescription>
              It starts as a draft, dated today. Nothing is public until you
              publish.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-post-title">Title</Label>
            <Input
              autoFocus
              data-testid="new-post-title"
              id="new-post-title"
              maxLength={200}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!slugEdited) {
                  setSlug(slugify(e.target.value));
                }
              }}
              value={title}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-post-slug">Path</Label>
            <div className="flex items-center gap-1">
              <span className="text-neutral-500">/blog/</span>
              <Input
                data-testid="new-post-slug"
                id="new-post-slug"
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.trim());
                }}
                value={slug}
              />
            </div>
            <p
              className={`min-h-5 text-xs ${slugState.status === "error" ? "text-danger" : "text-neutral-400"}`}
              data-testid="new-post-slug-status"
            >
              {slugState.status === "error"
                ? slugState.message
                : slugState.status === "checking"
                  ? "Checking…"
                  : slugState.status === "ok"
                    ? `Available: /blog/${slug}`
                    : ""}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-post-category">Category</Label>
            <select
              className={selectClass}
              data-testid="new-post-category"
              id="new-post-category"
              onChange={(e) => setCategoryChoice(e.target.value)}
              value={categoryChoice}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={NEW_CATEGORY}>New category…</option>
            </select>
            {categoryChoice === NEW_CATEGORY && (
              <Input
                aria-label="New category"
                data-testid="new-post-new-category"
                maxLength={100}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="e.g. AI Strategy"
                value={newCategory}
              />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-post-author">Author</Label>
            <Input
              aria-describedby="new-post-author-hint"
              data-testid="new-post-author"
              id="new-post-author"
              maxLength={100}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="e.g. Alex Doe"
              value={author}
            />
            <p
              className={`text-xs ${author.trim() ? "text-neutral-500" : "text-amber-300"}`}
              data-testid="new-post-author-hint"
              id="new-post-author-hint"
            >
              {author.trim()
                ? "The byline under the post's title."
                : "Required: the byline under the post's title."}
            </p>
          </div>
          {!!error && <p className="text-danger text-sm">{error}</p>}
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              data-testid="new-post-create"
              disabled={!canSubmit}
              type="submit"
            >
              {submitting ? "Creating…" : "Create post"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
