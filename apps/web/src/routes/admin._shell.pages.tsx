import type { PageListItem } from "@repo/cms-core/admin-result";
import { formatDateTime } from "@repo/cms-core/format-date";
import { isValidSlug, slugToPath } from "@repo/cms-core/paths";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
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

export const Route = createFileRoute("/admin/_shell/pages")({
  head: () => ({ meta: [{ title: "Pages | Admin" }] }),
  loader: ({ location }) =>
    redirectOnUnauthorized(
      getTrpc().cms.pages.listPages.query(),
      location.href
    ),
  component: PagesPage,
});

function PagesPage() {
  const result = Route.useLoaderData();
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold font-heading text-2xl">Pages</h1>
        <Button data-testid="new-page" onClick={openDialog}>
          <Plus /> New page
        </Button>
      </div>
      {/* Posts have their own list (/admin/posts). */}
      {result.ok ? (
        <PagesTable pages={result.pages.filter((p) => p.kind === "page")} />
      ) : (
        <p className="text-danger">{result.message}</p>
      )}
      <NewPageDialog onOpenChange={setOpen} open={open} />
    </div>
  );
}

const STATUS_CLASS: Record<PageListItem["status"], string> = {
  draft: "bg-neutral-700 text-neutral-200",
  published: "bg-emerald-700/60 text-emerald-100",
  archived: "bg-neutral-800 text-neutral-500",
};

function PagesTable({ pages }: { pages: PageListItem[] }) {
  const router = useRouter();
  const [unpublishing, setUnpublishing] = useState<UnpublishTarget | null>(
    null
  );
  const invalidate = useCallback(() => router.invalidate(), [router]);
  const closeUnpublish = useCallback(() => setUnpublishing(null), []);
  if (!pages.length) {
    return (
      <p className="text-neutral-400">
        No pages yet. Create one to get started.
      </p>
    );
  }
  return (
    <div className="relative overflow-x-auto rounded border border-neutral-800">
      {/* The body's `overflow-wrap: anywhere` (styles.css) breaks short words mid-word in table cells. */}
      <table
        className="w-full text-left text-sm [overflow-wrap:normal]"
        data-testid="pages-table"
      >
        <thead className="bg-neutral-900 text-neutral-400 text-xs uppercase tracking-wide">
          <tr>
            <th className="px-4 py-3 font-medium">Title</th>
            <th className="px-4 py-3 font-medium">Path</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Updated</th>
            <th className="px-4 py-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
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
              </td>
              <td className="px-4 py-3 font-mono text-neutral-400 text-xs">
                {slugToPath(p.slug)}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[p.status]}`}
                >
                  {p.status}
                </span>
              </td>
              <td className="px-4 py-3 text-neutral-400">
                {formatDateTime(p.updatedAt)}
              </td>
              <td className="px-4 py-3 text-right">
                {p.status === "published" && (
                  <UnpublishButton onPick={setUnpublishing} page={p} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <UnpublishDialog
        onClose={closeUnpublish}
        onDone={invalidate}
        target={unpublishing}
      />
    </div>
  );
}

function UnpublishButton({
  page,
  onPick,
}: {
  page: PageListItem;
  onPick: (target: UnpublishTarget) => void;
}) {
  const pick = useCallback(
    () => onPick({ id: page.id, kind: page.kind, path: slugToPath(page.slug) }),
    [page, onPick]
  );
  return (
    <Button
      data-testid={`unpublish-${page.slug}`}
      onClick={pick}
      size="sm"
      variant="ghost"
    >
      Unpublish
    </Button>
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

const COMBINING_MARKS_RE = /[̀-ͯ]/g;
const NON_SLUG_RE = /[^a-z0-9]+/g;
const EDGE_DASHES_RE = /^-+|-+$/g;
const TRAILING_DASHES_RE = /-+$/;
const LEADING_SLASHES_RE = /^\/+/;

/** "My new page!" → "my-new-page". */
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

function slugStatusText(state: SlugState, slug: string): string {
  switch (state.status) {
    case "error":
      return state.message;
    case "checking":
      return "Checking…";
    case "ok":
      return `Available: ${slugToPath(slug)}`;
    default:
      return "";
  }
}

type SlugState =
  | { status: "idle" | "checking" | "ok" }
  | { status: "error"; message: string };

function NewPageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugState, setSlugState] = useState<SlugState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onTitleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setTitle(e.target.value);
      if (!slugEdited) {
        setSlug(slugify(e.target.value));
      }
    },
    [slugEdited]
  );
  const onSlugChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSlugEdited(true);
    // Paths are often typed or pasted with their leading "/"; the slug has none.
    setSlug(e.target.value.trim().replace(LEADING_SLASHES_RE, ""));
  }, []);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setSlug("");
      setSlugEdited(false);
      setSlugState({ status: "idle" });
      setError(null);
    }
  }, [open]);

  // Format first (no round trip), then the server's rules: blog/, reserved and taken slugs.
  useEffect(() => {
    if (!slug) {
      return setSlugState({ status: "idle" });
    }
    if (!isValidSlug(slug)) {
      return setSlugState({
        status: "error",
        message:
          "Use lowercase words separated by - and /, e.g. services/new-offer",
      });
    }
    setSlugState({ status: "checking" });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await getTrpc().cms.pages.checkSlug.query({ slug });
        if (!cancelled) {
          setSlugState(
            res.ok
              ? { status: "ok" }
              : { status: "error", message: res.message }
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

  const canSubmit =
    title.trim() !== "" && slugState.status === "ok" && !submitting;

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSubmit) {
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await getTrpc().cms.pages.createPage.mutate({
          title: title.trim(),
          slug,
        });
        if (!res.ok) {
          setError(res.message);
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
    },
    [canSubmit, title, slug, onOpenChange, navigate]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="border-neutral-700 bg-neutral-900 text-neutral-100">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New page</DialogTitle>
            <DialogDescription>
              It starts as a draft with a hero. Nothing is public until you
              publish.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-page-title">Title</Label>
            <Input
              autoFocus
              data-testid="new-page-title"
              id="new-page-title"
              maxLength={200}
              onChange={onTitleChange}
              value={title}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-page-slug">Path</Label>
            <div className="flex items-center gap-1">
              <span className="text-neutral-500">/</span>
              <Input
                data-testid="new-page-slug"
                id="new-page-slug"
                onChange={onSlugChange}
                value={slug}
              />
            </div>
            <p
              className={`min-h-5 text-xs ${slugState.status === "error" ? "text-danger" : "text-neutral-400"}`}
              data-testid="new-page-slug-status"
            >
              {slugStatusText(slugState, slug)}
            </p>
          </div>
          {error ? <p className="text-danger text-sm">{error}</p> : null}
          <DialogFooter>
            <Button onClick={close} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              data-testid="new-page-create"
              disabled={!canSubmit}
              type="submit"
            >
              {submitting ? "Creating…" : "Create page"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
