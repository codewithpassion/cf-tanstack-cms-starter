// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/correctness/useImageSize: media-library thumbnails of unknown size, sized by CSS.
// biome-ignore-all lint/performance/noAwaitInLoops: sequential on purpose (ordered requests or test steps), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noExportedImports: re-exports the MediaInfo type for callers, as in the source.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; counters and index loops as in the source.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/suspicious/noBitwiseOperators: byte arithmetic in the local image-type sniffing (binary headers).
/**
 * Media library dialog and image field (docs/cms-plan.md §3.6 Media). Renders in the editor's
 * parent document, never inside the canvas iframe. Uploads go to POST /admin/api/media as
 * multipart (no presigned URLs); listing and alt text use the `cms.media` / `cms.agent` tRPC
 * procedures.
 *
 * No blob: previews: the site CSP has no `blob:` in img-src, so thumbnails only ever come
 * from /media/<id> after the upload returns.
 */
import { mediaUrl } from "@repo/cms-core/media";
import {
  detectImageType,
  IMAGE_TYPES,
  isAnimated,
} from "@repo/cms-core/media-bytes";
import type { MediaInfo } from "@repo/services/cms/media-service";
import { ImageIcon, Loader2, Sparkles, Upload } from "lucide-react";
import {
  type DragEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
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
import { Progress } from "#/components/ui/progress";
import { Textarea } from "#/components/ui/textarea";
import { goToLogin, isUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import { cn } from "#/lib/utils";
import { appendPage } from "./media-list";

export type { MediaInfo };

/** A signed-out call goes to sign-in; true when it did (the caller then leaves its state alone). */
function signedOut(e: unknown): boolean {
  if (isUnauthorized(e)) {
    goToLogin(window.location.pathname + window.location.search);
    return true;
  }
  return false;
}

/** Longest edge after client-side downscaling. */
const MAX_UPLOAD_EDGE = 2400;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif";
/** The image types the alt-text suggestion can read (@repo/services/agent/alt-text). */
const SUGGESTABLE_MIME = /^image\/(jpeg|png|gif|webp)$/;
/** Formats the canvas re-encodes; GIF (animation) and AVIF (no canvas encoder) go up untouched. */
const REENCODE = new Set<string>([
  IMAGE_TYPES.jpeg.mime,
  IMAGE_TYPES.png.mime,
  IMAGE_TYPES.webp.mime,
]);
// Same limits as the server (server/trpc/routers/cms/media.ts, @repo/services/cms/media-service).
const MAX_ALT = 300;
const MAX_TAGS = 20;
const MAX_TAG = 40;
const MAX_QUERY = 100;
const TAG_LIMIT_MESSAGE = `At most ${MAX_TAGS} tags of up to ${MAX_TAG} characters each.`;

/** A validation error that arrives as a JSON list of zod issues names the field instead. */
function friendlyError(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : "";
  try {
    const issues = JSON.parse(message) as { path?: unknown[] }[];
    if (Array.isArray(issues)) {
      const field = issues[0]?.path?.[0];
      if (field === "tags") {
        return TAG_LIMIT_MESSAGE;
      }
      if (field === "alt") {
        return `Alt text can be at most ${MAX_ALT} characters.`;
      }
      if (field === "query") {
        return `Searches can be at most ${MAX_QUERY} characters.`;
      }
      return fallback;
    }
  } catch {
    // Not JSON: a plain message from the server.
  }
  return message || fallback;
}

/** Size that fits within `max` on the longest edge, or null when no downscale is needed. */
function fitWithin(
  width: number,
  height: number,
  max = MAX_UPLOAD_EDGE
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= max) {
    return null;
  }
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * JPEGs are always re-encoded through a canvas: that drops EXIF (GPS, camera details) and bakes
 * the EXIF orientation into the pixels. Still PNG/WebP are re-encoded only to downscale them over
 * the edge limit. Animated WebP/APNG, GIF and AVIF are sent as-is. The type comes from the bytes.
 */
export async function prepareUpload(file: File): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const type = detectImageType(head);
  if (!(type && REENCODE.has(type.mime)) || isAnimated(head, type)) {
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // Applies EXIF orientation.
  } catch {
    return file; // Let the server decide.
  }
  try {
    const isJpeg = type.mime === IMAGE_TYPES.jpeg.mime;
    const size =
      fitWithin(bitmap.width, bitmap.height) ??
      (isJpeg ? { width: bitmap.width, height: bitmap.height } : null);
    if (!size) {
      return file; // Original bytes: re-uploading the same file dedupes.
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return file;
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type.mime, 0.9)
    );
    // toBlob falls back to PNG for a type it can't encode; only use a blob of the same type.
    return blob?.type === type.mime ? blob : file;
  } finally {
    bitmap.close();
  }
}

type UploadResponse = MediaInfo & { created: boolean };

function postMedia(
  blob: Blob,
  name: string,
  onProgress: (pct: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", blob, name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/admin/api/media");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        goToLogin(window.location.pathname + window.location.search);
        reject(new Error("You were signed out."));
        return;
      }
      const body = xhr.response as
        | (UploadResponse & { message?: string })
        | null;
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body);
      } else {
        reject(new Error(body?.message ?? `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(form);
  });
}

type UploadState = {
  key: string;
  name: string;
  progress: number;
  error?: string;
  note?: string;
};

/** Mirrors the server search (@repo/services/cms/media-service `matchesQuery`). */
function matchesSearch(m: MediaInfo, query: string): boolean {
  const q = query.toLowerCase();
  return (
    !q ||
    [m.id, m.alt ?? "", ...m.tags].some((s) => s.toLowerCase().includes(q))
  );
}

export type MediaLibraryProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (media: MediaInfo) => void;
  /** Preselects this item when it is on the first page. */
  selectedId?: string;
  /** Only these MIME types are listed and pickable (e.g. a share image: JPEG, PNG, WebP); all when absent. */
  accept?: readonly string[];
};

/** "JPEG, PNG, WebP" from MIME types. */
const formatNames = (mimes: readonly string[]) =>
  mimes
    .map((m) =>
      m === "image/jpeg"
        ? "JPEG"
        : m === "image/webp"
          ? "WebP"
          : m.replace("image/", "").toUpperCase()
    )
    .join(", ");

/** The library as a dialog (the editor's image picker). */
export function MediaLibrary({
  open,
  onOpenChange,
  onPick,
  selectedId,
  accept,
}: MediaLibraryProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-4xl`: this repo's shadcn DialogContent sets `sm:max-w-sm`, which beats a plain max-w. */}
      <DialogContent className="gap-3 border-neutral-700 sm:max-w-4xl bg-neutral-900 text-neutral-100">
        <DialogHeader>
          <DialogTitle>Media library</DialogTitle>
          <DialogDescription className="text-neutral-400">
            Pick an image, or drop files here to upload (
            {accept ? formatNames(accept) : "JPEG, PNG, WebP, GIF, AVIF"}; up to
            10 MB).
          </DialogDescription>
        </DialogHeader>
        <MediaBrowser
          active={open}
          selectedId={selectedId}
          accept={accept}
          onPick={(m) => {
            onPick(m);
            onOpenChange(false);
          }}
          footer={(current, pick) => (
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!current}
                onClick={() => pick(current)}
              >
                Pick
              </Button>
            </DialogFooter>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}

export type MediaBrowserProps = {
  /** Loads (and reloads) the list while true. */
  active: boolean;
  selectedId?: string;
  accept?: readonly string[];
  /** Double-click or the footer's pick; without it a double-click only selects. */
  onPick?: (media: MediaInfo) => void;
  footer?: (
    current: MediaInfo | null,
    pick: (media: MediaInfo | null) => void
  ) => ReactNode;
  /** More about the selected image, under its alt text (the /admin/media page: URL, where it's used). */
  details?: (media: MediaInfo) => ReactNode;
  /** Height of the image grid. */
  gridClassName?: string;
};

/**
 * Search, upload (drop or pick files), the image grid and the alt text editor: the body of the
 * library dialog and of the /admin/media page.
 */
export function MediaBrowser({
  active: open,
  selectedId,
  accept,
  onPick,
  footer,
  details,
  gridClassName,
}: MediaBrowserProps) {
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const inspector = useRef<HTMLElement>(null);
  // Bumped by a tile click; scrolls once the inspector has rendered the new selection.
  const [revealInspector, setRevealInspector] = useState(0);

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<MediaInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedId ?? null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  // Share images the AI agent rendered are hidden unless asked for.
  const [includeAgent, setIncludeAgent] = useState(false);
  // The search the current list was loaded for, read by uploads that finish later.
  const activeQuery = useRef("");
  // Only the latest list request may update the list (a slow earlier search must not win).
  const loadSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async (cursor?: string) => {
      const seq = ++loadSeq.current;
      activeQuery.current = debounced;
      setLoading(true);
      setError(null);
      try {
        const res = await getTrpc().cms.media.listMedia.query({
          query: debounced || undefined,
          cursor,
          ...(includeAgent && { includeAgent }),
        });
        if (seq !== loadSeq.current) {
          return;
        }
        setItems((prev) => (cursor ? appendPage(prev, res.items) : res.items));
        setNextCursor(res.nextCursor);
      } catch (e) {
        // Signed out: on the way to sign-in, so leave the list.
        if (!signedOut(e) && seq === loadSeq.current) {
          setError(friendlyError(e, "Could not load media."));
        }
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
        }
      }
    },
    [debounced, includeAgent]
  );

  // Files dropped outside the dialog box (on the overlay) would otherwise open in the tab.
  useEffect(() => {
    if (!open) {
      return;
    }
    const block = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
      }
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  useEffect(() => {
    if (open) {
      setSelected(selectedId ?? null);
    }
  }, [open, selectedId]);

  // Below md the inspector sits under the grid. Scroll after render: before it, the page can be
  // too short to scroll (the empty inspector is one line).
  useEffect(() => {
    if (revealInspector && !window.matchMedia("(min-width: 768px)").matches) {
      inspector.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [revealInspector]);

  const usable = (m: MediaInfo) => !accept || accept.includes(m.mime);
  const shown = accept ? items.filter(usable) : items;
  const current = shown.find((m) => m.id === selected) ?? null;

  const upload = async (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      const patch = (p: Partial<UploadState>) =>
        setUploads((us) => us.map((u) => (u.key === key ? { ...u, ...p } : u)));
      setUploads((us) => [...us, { key, name: file.name, progress: 0 }]);
      try {
        const blob = await prepareUpload(file);
        if (blob.size > MAX_UPLOAD_BYTES) {
          throw new Error("Images can be at most 10 MB.");
        }
        const { created, ...media } = await postMedia(
          blob,
          file.name,
          (progress) => patch({ progress })
        );
        const done = created
          ? `Uploaded ${file.name}.`
          : `${file.name} is already in the library.`;
        if (!usable(media)) {
          const note = `${done} It can't be used here: pick ${formatNames(accept ?? [])}.`;
          patch({ progress: 100, note });
          setStatus(note);
        } else if (matchesSearch(media, activeQuery.current)) {
          setItems((prev) => [media, ...prev.filter((m) => m.id !== media.id)]);
          setSelected(media.id);
          setStatus(done);
          setUploads((us) => us.filter((u) => u.key !== key));
        } else {
          // Not part of the filtered list: say so instead of showing it under a search it doesn't match.
          const note = `${done} Clear the search to see it.`;
          patch({ progress: 100, note });
          setStatus(note);
        }
      } catch (e) {
        const message = friendlyError(e, "Upload failed.");
        patch({ error: message });
        setStatus(`${file.name}: ${message}`);
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) {
      void upload(files);
    }
  };

  const pick = (media: MediaInfo | null) => {
    if (media) {
      onPick?.(media);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone for files, as the dialog was in the source; Upload is the keyboard path.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same drop zone.
    <div
      className="flex flex-col gap-3"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${ids}-search`} className="sr-only">
          Search media
        </Label>
        <Input
          id={`${ids}-search`}
          type="search"
          placeholder="Search alt text, tags or id"
          maxLength={MAX_QUERY}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 flex-1 border-neutral-700 bg-neutral-950"
        />
        <label
          className="flex items-center gap-1.5 text-xs text-neutral-400"
          title="Share images the AI agent rendered"
        >
          <input
            type="checkbox"
            checked={includeAgent}
            onChange={(e) => setIncludeAgent(e.target.checked)}
            data-testid="media-include-agent"
          />
          Agent images
        </label>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => fileInput.current?.click()}
        >
          <Upload aria-hidden /> Upload
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={accept?.join(",") ?? ACCEPT}
          multiple
          hidden
          data-testid="media-file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) {
              void upload(files);
            }
          }}
        />
      </div>

      <p aria-live="polite" className="sr-only">
        {status}
      </p>
      {uploads.length > 0 && (
        <ul className="space-y-1 text-xs">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center gap-2">
              <span className="w-48 truncate">{u.name}</span>
              {u.error ? (
                <span className="text-red-400">{u.error}</span>
              ) : u.note ? (
                <span className="text-neutral-300">{u.note}</span>
              ) : (
                <Progress
                  value={u.progress}
                  className="h-2 flex-1"
                  aria-label={`Uploading ${u.name}`}
                />
              )}
              {!!(u.error || u.note) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() =>
                    setUploads((us) => us.filter((x) => x.key !== u.key))
                  }
                >
                  Dismiss
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_16rem]">
        <div
          className={cn(
            "overflow-y-auto rounded-md border border-dashed p-2",
            gridClassName ?? "h-[55vh]",
            dragging ? "border-accent bg-accent/5" : "border-neutral-700"
          )}
        >
          {!!error && <p className="p-2 text-sm text-red-400">{error}</p>}
          {!(error || loading) && shown.length === 0 && (
            <p className="p-6 text-center text-sm text-neutral-400">
              {debounced
                ? "Nothing matches that search."
                : "No images yet. Drop files here or use Upload."}
            </p>
          )}
          <ul
            className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5"
            aria-label="Images"
          >
            {shown.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={m.id === selected}
                  aria-label={
                    m.alt || `Image ${m.id.slice(0, 8)} (no alt text)`
                  }
                  onClick={() => {
                    setSelected(m.id);
                    setRevealInspector((n) => n + 1);
                  }}
                  onDoubleClick={() => pick(m)}
                  className={cn(
                    "block aspect-square w-full overflow-hidden rounded border-2 bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    m.id === selected
                      ? "border-accent"
                      : "border-transparent hover:border-neutral-500"
                  )}
                >
                  <img
                    src={m.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-contain"
                  />
                </button>
              </li>
            ))}
          </ul>
          {!!loading && (
            <p className="flex items-center justify-center gap-2 p-3 text-sm text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
            </p>
          )}
          {nextCursor && !loading && (
            <div className="p-2 text-center">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void load(nextCursor)}
              >
                Load more
              </Button>
            </div>
          )}
        </div>

        <aside
          aria-label="Selected image"
          className="min-w-0 scroll-mt-4 text-sm"
          ref={inspector}
        >
          {current ? (
            // Keyed as one unit: `details` may key its element by the same id, and same-key
            // siblings left a stale inspector behind on every selection.
            <Fragment key={current.id}>
              <AltEditor
                media={current}
                onSaved={(m) =>
                  setItems((prev) => prev.map((x) => (x.id === m.id ? m : x)))
                }
              />
              {details?.(current)}
            </Fragment>
          ) : (
            <p className="text-neutral-400">
              Select an image to edit its alt text.
            </p>
          )}
        </aside>
      </div>

      {footer?.(current, pick)}
    </div>
  );
}

function AltEditor({
  media,
  onSaved,
}: {
  media: MediaInfo;
  onSaved: (m: MediaInfo) => void;
}) {
  const ids = useId();
  const [alt, setAlt] = useState(media.alt ?? "");
  const [tags, setTags] = useState(media.tags.join(", "));
  const [state, setState] = useState<
    "idle" | "saving" | "saved" | { error: string }
  >("idle");
  const [suggesting, setSuggesting] = useState(false);
  const dirty = alt !== (media.alt ?? "") || tags !== media.tags.join(", ");

  /** "Suggest": the AI page agent's model describes the image (docs/cms-plan.md §4.2); nothing is saved until Save. */
  const suggest = async () => {
    setSuggesting(true);
    setState("idle");
    try {
      const res = await getTrpc().cms.agent.suggestAltText.mutate({
        id: media.id,
        ...(tags.trim() && { context: `Tags: ${tags}` }),
      });
      if (!res.ok) {
        setState({ error: res.message || "Could not suggest alt text." });
        return;
      }
      setAlt(res.decorative ? "" : res.alt);
      if (res.decorative) {
        setState({ error: "Looks decorative: leave the alt text empty." });
      }
    } catch (e) {
      if (!signedOut(e)) {
        setState({ error: friendlyError(e, "Could not suggest alt text.") });
      }
    } finally {
      setSuggesting(false);
    }
  };

  const submit = async () => {
    const tagList = [
      ...new Set(
        tags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      ),
    ];
    if (tagList.length > MAX_TAGS || tagList.some((t) => t.length > MAX_TAG)) {
      setState({ error: TAG_LIMIT_MESSAGE });
      return;
    }
    setState("saving");
    try {
      const saved = await getTrpc().cms.media.updateMediaAlt.mutate({
        id: media.id,
        alt,
        tags: tagList,
      });
      onSaved(saved);
      setState("saved");
    } catch (e) {
      if (signedOut(e)) {
        setState("idle");
        return;
      }
      setState({ error: friendlyError(e, "Could not save.") });
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <img
        src={media.url}
        alt=""
        className="aspect-video w-full rounded bg-neutral-950 object-contain"
      />
      <p className="text-xs text-neutral-400">
        {media.width && media.height ? `${media.width}×${media.height} · ` : ""}
        {media.mime.replace("image/", "").toUpperCase()}
      </p>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${ids}-alt`}>Alt text</Label>
          <button
            type="button"
            onClick={() => void suggest()}
            disabled={suggesting || !SUGGESTABLE_MIME.test(media.mime)}
            className="flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40"
            title="Ask the AI to describe this image (not saved until you click Save)"
            data-testid="suggest-alt"
          >
            {suggesting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}{" "}
            Suggest
          </button>
        </div>
        <Textarea
          id={`${ids}-alt`}
          value={alt}
          maxLength={MAX_ALT}
          rows={3}
          placeholder="What the image shows, and why it's there"
          onChange={(e) => {
            setAlt(e.target.value);
            setState("idle");
          }}
          className="border-neutral-700 bg-neutral-950"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${ids}-tags`}>Tags</Label>
        <Input
          id={`${ids}-tags`}
          value={tags}
          placeholder="comma, separated"
          onChange={(e) => {
            setTags(e.target.value);
            setState("idle");
          }}
          className="h-9 border-neutral-700 bg-neutral-950"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!dirty || state === "saving"}
        >
          {state === "saving" ? "Saving…" : "Save"}
        </Button>
        <span aria-live="polite" className="text-xs">
          {state === "saved" && <span className="text-neutral-400">Saved</span>}
          {typeof state === "object" && (
            <span className="text-red-400">{state.error}</span>
          )}
        </span>
      </div>
    </form>
  );
}

/** An image reference as blocks store it (see @repo/cms-core/blocks/image). */
export type ImageValue = {
  mediaId: string;
  alt: string;
  width?: number;
  height?: number;
};

/**
 * Thumbnail + "Choose image" + alt display, for the inspector. Opens the library on demand.
 * `onChange` gets the image as an `ImageValue`; `onPick`/`onRemove`, when given, get the picked
 * library item itself (for callers that fill other fields from it) and the removal instead.
 * `altNote` replaces the alt text line, for images whose alt text lives elsewhere.
 */
export function ImageField({
  value,
  onChange,
  onPick,
  onRemove,
  label = "Image",
  altNote,
  removable = true,
  accept,
}: {
  value: ImageValue | undefined;
  onChange?: (value: ImageValue | undefined) => void;
  onPick?: (media: MediaInfo) => void;
  onRemove?: () => void;
  label?: string;
  altNote?: string;
  removable?: boolean;
  /** MediaLibrary `accept`. */
  accept?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 text-sm" data-testid="image-field">
      {!!label && <span className="block font-medium">{label}</span>}
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-neutral-700 bg-neutral-950">
          {value ? (
            <img
              src={mediaUrl(value.mediaId)}
              alt=""
              className="h-full w-full object-cover"
              data-testid="image-field-thumb"
            />
          ) : (
            <ImageIcon className="h-6 w-6 text-neutral-500" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={cn(
              "line-clamp-2",
              value?.alt && !altNote ? "" : "text-neutral-400"
            )}
            data-testid="image-field-alt"
          >
            {value
              ? (altNote ?? (value.alt ? `Alt: ${value.alt}` : "No alt text"))
              : "No image chosen"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 px-2"
              onClick={() => setOpen(true)}
              data-testid="image-field-choose"
            >
              {value ? "Change image" : "Choose image"}
            </Button>
            {!!value && removable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => (onRemove ? onRemove() : onChange?.(undefined))}
                data-testid="image-field-remove"
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      <MediaLibrary
        open={open}
        onOpenChange={setOpen}
        selectedId={value?.mediaId}
        accept={accept}
        onPick={(m) =>
          onPick
            ? onPick(m)
            : onChange?.({
                mediaId: m.id,
                alt: m.alt ?? "",
                width: m.width ?? undefined,
                height: m.height ?? undefined,
              })
        }
      />
    </div>
  );
}
