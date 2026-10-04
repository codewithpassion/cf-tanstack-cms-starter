// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the save loop is ported verbatim from the source (kept diffable).
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noAwaitInLoops: the save loop waits for the request in flight on purpose, as in the source.
// biome-ignore-all lint/performance/noDelete: removing the key (not setting undefined) keeps the doc equal to a fresh one under deepEqual and the strict schema, as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source (kept diffable); inline handlers in an admin-only form that is not render-hot.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source (kept diffable); not in a hot loop.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the editor proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source (kept diffable); reads a ref's current value.
// biome-ignore-all lint/suspicious/noArrayIndexKey: the change list is rebuilt per render from strings with no ids and never reordered.
// biome-ignore-all lint/suspicious/noAssignInExpressions: edit callbacks assign into the draft copy, ported verbatim from the source (kept diffable).
// biome-ignore-all lint/suspicious/noReturnAssign: edit callbacks assign into the draft copy, ported verbatim from the source (kept diffable).
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, stashed drafts, refs changed across awaits), as in the source.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AdminError, AdminResult } from "@repo/cms-core/admin-result";
import { validateSiteDoc } from "@repo/cms-core/site/schema";
import type { SiteDoc, SiteLink } from "@repo/cms-core/site/types";
import type { SitePublishResult } from "@repo/services/cms/site-service";
import { useBlocker } from "@tanstack/react-router";
import { GripVertical, History, Plus, RotateCcw, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import superjson from "superjson";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  SiteEditorState,
  SiteRevisionItem,
} from "#/server/trpc/routers/cms/site";

import { ImageField } from "../editor/media-library";
import { signedOutAsResult } from "../editor/signed-out";

/**
 * `/admin/site` (docs/cms-plan.md §3.7 "Site doc"): nav, footer, SEO defaults and brand swatches.
 * Edits autosave as a draft (1.5 s debounce, validated here first so only valid docs are sent);
 * "Publish site settings" makes the draft live (KV `site`) after showing what changes; History
 * restores any earlier version into the draft, and "Save version…" (Ctrl/Cmd+Shift+S) names one.
 *
 * Leaving with edits not saved asks first (router navigation and closing the tab). Valid edits are
 * saved on the way out; edits with problems can't be, so they're kept in this browser tab
 * (sessionStorage) and shown again, with their errors, when the editor opens next on the same
 * draft. Removing a footer column or a nav item with dropdown links asks first and keeps the draft
 * as it was in History.
 */

const AUTOSAVE_MS = 1500;
const key = () => nanoid(10);

type Status = "saved" | "unsaved" | "saving" | "invalid" | "error";

type Failure = { code: string; message: string };

/** One save: a retry of a save whose answer never came sends the same batch (site-service `batchId`). */
type Batch = { batchId: string; draftVersion: number; doc: SiteDoc };

type SaveDraftInput = {
  draftVersion: number;
  doc: SiteDoc;
  batchId: string;
};
type SaveDraftResult = AdminResult<SiteEditorState> | AdminError;

/** Browsers refuse keepalive requests whose body is over 64 KiB; a bigger save goes as a normal request. */
const KEEPALIVE_MAX_BYTES = 60_000;
const SAVE_DRAFT_URL = "/api/trpc/cms.site.saveSiteDraft";

/**
 * `cms.site.saveSiteDraft` as a keepalive request, so a save started while the tab closes still
 * arrives. The tRPC client can't set `keepalive` per call, so this posts the procedure's wire format
 * (superjson, as the client's link) directly; any failure throws, like a lost request.
 */
async function saveDraftKeepalive(
  input: SaveDraftInput
): Promise<SaveDraftResult> {
  const body = JSON.stringify(superjson.serialize(input));
  const res = await fetch(SAVE_DRAFT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: new Blob([body]).size <= KEEPALIVE_MAX_BYTES,
  });
  if (!res.ok) {
    throw new Error(`Save failed (${res.status})`);
  }
  const json = (await res.json()) as {
    result: { data: Parameters<typeof superjson.deserialize>[0] };
  };
  return superjson.deserialize<SaveDraftResult>(json.result.data);
}

const saveDraft = (
  input: SaveDraftInput,
  keepalive: boolean
): Promise<SaveDraftResult> =>
  keepalive
    ? saveDraftKeepalive(input)
    : getTrpc().cms.site.saveSiteDraft.mutate(input);

/** Edits with problems left behind when the editor closed, with the draft version they were made on. */
const STASH_KEY = "cms-site-unsaved";
type Stash = { draftVersion: number; doc: SiteDoc };

function takeStash(): Stash | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) {
      return null;
    }
    sessionStorage.removeItem(STASH_KEY);
    const s = JSON.parse(raw) as {
      draftVersion?: unknown;
      doc?: Partial<SiteDoc>;
    };
    const d = s.doc;
    // The editor renders it, so it needs the doc's shape (its values may be invalid).
    const shaped =
      d?._schema === 1 &&
      Array.isArray(d.nav?.links) &&
      Array.isArray(d.footer?.columns) &&
      Array.isArray(d.footer?.legalLinks) &&
      Array.isArray(d.footer?.highlights?.items) &&
      Array.isArray(d.seo?.organization?.sameAs) &&
      Array.isArray(d.swatches);
    return typeof s.draftVersion === "number" && shaped
      ? { draftVersion: s.draftVersion, doc: d as SiteDoc }
      : null;
  } catch {
    return null;
  }
}

/** After a save: a stash left by a reload the user then cancelled is out of date. */
function clearStash() {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    // Storage unavailable: nothing was stashed.
  }
}

function putStash(stash: Stash) {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(stash));
  } catch {
    // Storage unavailable: the edits are lost, as they would be anyway.
  }
}

/** Formats the default share image may use (what the social platforms all read). */
const SHARE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** A pending destructive edit: confirmed, then the draft is kept in History before `apply`. */
type Removal = { what: string; reason: string; apply: () => void };

export function SiteEditor({ initial }: { initial: SiteEditorState }) {
  const [doc, setDoc] = useState(initial.doc);
  const [server, setServer] = useState(initial);
  const [status, setStatus] = useState<Status>("saved");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const validation = useMemo(() => validateSiteDoc(doc), [doc]);
  const errors = useMemo(() => {
    const map = new Map<string, string>();
    if (!validation.ok) {
      for (const e of validation.errors) {
        if (!map.has(e.path)) {
          map.set(e.path, e.message);
        }
      }
    }
    return map;
  }, [validation]);

  // Autosave: the latest doc, against the latest draft version; one request at a time.
  const docRef = useRef(doc);
  const versionRef = useRef(initial.draftVersion);
  const savedRef = useRef(initial.doc);
  const statusRef = useRef(status);
  // A save that got no answer (network): resent unchanged before anything else is saved.
  const pendingRef = useRef<Batch | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  docRef.current = doc;
  statusRef.current = status;

  const save = useCallback(
    async (opts?: { keepalive?: boolean }): Promise<boolean> => {
      while (inFlight.current) {
        await inFlight.current;
      }
      let ok = false;
      inFlight.current = (async () => {
        for (;;) {
          const replay = pendingRef.current;
          const current = docRef.current;
          if (!replay && current === savedRef.current) {
            // Nothing (left) to save, e.g. after a resent save with no edits since.
            setStatus("saved");
            ok = true;
            return;
          }
          if (!(replay || validateSiteDoc(current).ok)) {
            setStatus("invalid");
            return;
          }
          const batch = replay ?? {
            batchId: nanoid(),
            draftVersion: versionRef.current,
            doc: current,
          };
          setStatus("saving");
          let res: SaveDraftResult;
          try {
            res = await signedOutAsResult(() =>
              saveDraft(
                {
                  draftVersion: batch.draftVersion,
                  doc: batch.doc,
                  batchId: batch.batchId,
                },
                opts?.keepalive === true
              )
            );
          } catch {
            pendingRef.current = batch;
            setFailure({
              code: "NETWORK",
              message:
                "The draft couldn't be saved (no answer from the server). It's tried again with your next edit.",
            });
            setStatus("error");
            return;
          }
          pendingRef.current = null;
          if (!res.ok) {
            setFailure(res);
            setStatus("error");
            return;
          }
          versionRef.current = res.draftVersion;
          savedRef.current = batch.doc;
          setServer(res);
          setFailure(null);
          clearStash();
          if (!replay) {
            setStatus(docRef.current === batch.doc ? "saved" : "unsaved");
            ok = true;
            return;
          }
          // The resent save is in; now the edits made since.
        }
      })();
      await inFlight.current;
      inFlight.current = null;
      return ok;
    },
    []
  );

  useEffect(() => {
    if (doc === savedRef.current) {
      return;
    }
    setStatus(validation.ok ? "unsaved" : "invalid");
    if (!validation.ok) {
      return;
    }
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [doc, validation.ok, save]);

  const edit = useCallback((fn: (draft: SiteDoc) => void) => {
    setDoc((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }, []);

  // Leaving: ask while anything isn't saved (the router's own beforeunload is off: ours stashes).
  const blocker = useBlocker({
    shouldBlockFn: () => statusRef.current !== "saved",
    enableBeforeUnload: false,
    withResolver: true,
  });

  useEffect(() => {
    // Edits left behind with problems last time, on this same draft: back, with their errors.
    const stash = takeStash();
    if (stash && stash.draftVersion === initial.draftVersion) {
      setDoc(stash.doc);
      setNotice(
        "Your unsaved edits from before you left are back. Fix the problems marked in red to save them."
      );
    } else if (stash) {
      setNotice(
        "Unsaved edits from before you left were dropped: the site settings have been saved since."
      );
    }
    // Leaving the editor: save valid edits, keep the others for next time.
    const leave = (keepalive: boolean) => {
      const current = docRef.current;
      if (current === savedRef.current && !pendingRef.current) {
        return;
      }
      if (validateSiteDoc(current).ok) {
        void save({ keepalive });
      } else {
        putStash({ draftVersion: versionRef.current, doc: current });
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (statusRef.current === "saved") {
        return;
      }
      leave(true);
      e.preventDefault();
    };
    // "Save version…": Ctrl/Cmd+Shift+S, also while typing (this page is all fields), not over a dialog.
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        !((e.metaKey || e.ctrlKey) && e.shiftKey) ||
        e.altKey ||
        e.key.toLowerCase() !== "s"
      ) {
        return;
      }
      e.preventDefault();
      if (
        !document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        )
      ) {
        setVersionOpen(true);
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown);
      leave(false);
    };
    // Mount only: `save` is stable, and `initial` is this mount's.
  }, []);

  /** Asks, then keeps the draft in History, then removes (footer column, nav item with dropdown links). */
  const confirmRemove = useCallback(
    (what: string, apply: () => void) =>
      setRemoval({ what, reason: `Before removing ${what}`, apply }),
    []
  );

  const removeConfirmed = async (r: Removal): Promise<string | null> => {
    // Saves pending edits first; with problems, the saved draft is what History keeps.
    await save();
    let res: AdminResult<{ revId: string | null }> | AdminError;
    try {
      res = await signedOutAsResult(() =>
        getTrpc().cms.site.snapshotSite.mutate({
          draftVersion: versionRef.current,
          reason: r.reason,
        })
      );
    } catch {
      return "The draft couldn't be kept in History (no answer from the server), so nothing was removed.";
    }
    if (!res.ok) {
      return `Nothing was removed: ${res.message}`;
    }
    r.apply();
    if (res.revId) {
      setHistoryKey((k) => k + 1);
    }
    return null;
  };

  const saveVersion = async (label: string): Promise<string | null> => {
    if (!(await save())) {
      return "Only saved settings can be kept as a version: fix the problems marked in red first.";
    }
    let res: AdminResult<{ revId: string }> | AdminError;
    try {
      res = await signedOutAsResult(() =>
        getTrpc().cms.site.saveSiteVersion.mutate({
          label,
          draftVersion: versionRef.current,
        })
      );
    } catch {
      return "The version couldn't be saved (no answer from the server).";
    }
    if (!res.ok) {
      return res.message;
    }
    setNotice(`Saved version “${label}”. Find it in History.`);
    setHistoryKey((k) => k + 1);
    return null;
  };

  /** Replaces the editor state with the server's (after a restore). */
  const reset = (state: SiteEditorState) => {
    versionRef.current = state.draftVersion;
    savedRef.current = state.doc;
    pendingRef.current = null;
    setDoc(state.doc);
    setServer(state);
    setStatus("saved");
    setFailure(null);
  };

  const openPublish = async () => {
    if (await save()) {
      setPublishOpen(true);
    }
  };

  const unpublished = server.changes.length;

  return (
    <div className="p-8" data-testid="site-editor">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <h1 className="font-heading text-2xl font-bold">Site</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Navigation, footer, SEO defaults and brand colours for every page.
            Changes save as a draft; publish to put them live.
          </p>
        </div>
        {/* Wraps as whole items on narrow screens; the labels themselves never break. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusText status={status} errorCount={errors.size} />
          <Button
            variant="ghost"
            size="sm"
            title="Save version… (Ctrl/Cmd+Shift+S)"
            onClick={() => setVersionOpen(true)}
            data-testid="site-save-version"
          >
            Save version…
          </Button>
          <span
            className="whitespace-nowrap text-xs text-muted-foreground"
            data-testid="site-unpublished"
          >
            {unpublished
              ? `${unpublished} unpublished change${unpublished === 1 ? "" : "s"}`
              : "Live is up to date"}
          </span>
          <Button
            onClick={() => void openPublish()}
            disabled={
              status === "invalid" ||
              status === "saving" ||
              (unpublished === 0 && status === "saved")
            }
            data-testid="site-publish"
          >
            Publish site settings
          </Button>
        </div>
      </div>
      {!!failure && (
        <p
          className="mb-4 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {failure.code === "STALE_DRAFT"
            ? "Someone else saved the site settings. Reload the page to get their version (your unsaved edits will be lost)."
            : failure.message}
        </p>
      )}
      {!!notice && (
        <p
          className="mb-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
          role="status"
        >
          {notice}
        </p>
      )}

      <Tabs defaultValue="nav">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="nav">Navigation</TabsTrigger>
          <TabsTrigger value="footer">Footer</TabsTrigger>
          <TabsTrigger value="seo">SEO defaults</TabsTrigger>
          <TabsTrigger value="swatches">Brand swatches</TabsTrigger>
          <TabsTrigger value="history" data-testid="site-history-tab">
            <History className="mr-1 h-3.5 w-3.5" /> History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="nav" className="max-w-3xl">
          <NavSection
            doc={doc}
            edit={edit}
            errors={errors}
            confirmRemove={confirmRemove}
          />
        </TabsContent>
        <TabsContent value="footer" className="max-w-3xl">
          <FooterSection
            doc={doc}
            edit={edit}
            errors={errors}
            confirmRemove={confirmRemove}
          />
        </TabsContent>
        <TabsContent value="seo" className="max-w-3xl">
          <SeoSection doc={doc} edit={edit} errors={errors} />
        </TabsContent>
        <TabsContent value="swatches" className="max-w-3xl">
          <SwatchesSection doc={doc} edit={edit} errors={errors} />
        </TabsContent>
        <TabsContent value="history" className="max-w-3xl">
          <HistorySection
            key={historyKey}
            draftVersion={() => versionRef.current}
            beforeRestore={save}
            onRestored={(state) => {
              reset(state);
              setNotice("Restored into the draft. Publish to make it live.");
              setHistoryKey((k) => k + 1);
            }}
          />
        </TabsContent>
      </Tabs>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        changes={server.changes}
        draftVersion={() => versionRef.current}
        onPublished={(message) => {
          setServer((s) => ({ ...s, changes: [] }));
          setNotice(message);
          setHistoryKey((k) => k + 1);
        }}
      />
      <SaveVersionDialog
        open={versionOpen}
        onOpenChange={setVersionOpen}
        onSubmit={saveVersion}
      />
      <RemoveDialog
        removal={removal}
        onClose={() => setRemoval(null)}
        onConfirm={removeConfirmed}
      />
      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => !open && blocker.reset?.()}
      >
        <AlertDialogContent data-testid="site-leave-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave with unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {leaveMessage(status, errors.size)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => blocker.reset?.()}
              data-testid="site-leave-stay"
            >
              Stay
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => blocker.proceed?.()}
              data-testid="site-leave-go"
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function leaveMessage(status: Status, problems: number): string {
  if (status === "invalid") {
    return `Your latest edits have ${problems} problem${problems === 1 ? "" : "s"}, so they can't be saved. If you leave, they're kept in this browser tab and shown again when you come back to Site.`;
  }
  if (status === "error") {
    return "The last save failed. Leaving tries it once more; if that fails too, your latest edits are lost.";
  }
  return "Your latest edits are still being saved. If you leave now, they're saved on the way out.";
}

function StatusText({
  status,
  errorCount,
}: {
  status: Status;
  errorCount: number;
}) {
  const text: Record<Status, string> = {
    saved: "Draft saved",
    unsaved: "Unsaved changes…",
    saving: "Saving…",
    invalid: `Fix ${errorCount} problem${errorCount === 1 ? "" : "s"} to save`,
    error: "Not saved",
  };
  return (
    <span
      className={`whitespace-nowrap text-xs ${status === "invalid" || status === "error" ? "text-destructive" : "text-muted-foreground"}`}
      data-testid="site-status"
    >
      {text[status]}
    </span>
  );
}

// --- sections ----------------------------------------------------------------------------------

type SectionProps = {
  doc: SiteDoc;
  edit: (fn: (d: SiteDoc) => void) => void;
  errors: Map<string, string>;
};
type ConfirmRemove = (what: string, apply: () => void) => void;

const linkCount = (n: number) => `${n} link${n === 1 ? "" : "s"}`;

function NavSection({
  doc,
  edit,
  errors,
  confirmRemove,
}: SectionProps & { confirmRemove: ConfirmRemove }) {
  return (
    <div className="space-y-6 py-4">
      <Group
        title="Nav links"
        hint="Shown in the top bar and the mobile menu. Links with dropdown items show them on hover (desktop) or indented (mobile)."
      >
        <SortableList
          items={doc.nav.links}
          onReorder={(from, to) =>
            edit((d) => void (d.nav.links = arrayMove(d.nav.links, from, to)))
          }
          testId="nav-links"
          render={(link, i) => (
            <div className="flex-1 space-y-2">
              <LinkFields
                link={link}
                path={`nav.links[${i}]`}
                errors={errors}
                onChange={(patch) =>
                  edit((d) => Object.assign(d.nav.links[i]!, patch))
                }
                onRemove={() => {
                  const remove = () =>
                    edit(
                      (d) =>
                        void (d.nav.links = d.nav.links.filter(
                          (l) => l._key !== link._key
                        ))
                    );
                  if (link.children?.length) {
                    confirmRemove(
                      `“${link.label}” and its ${linkCount(link.children.length)} in the dropdown`,
                      remove
                    );
                  } else {
                    remove();
                  }
                }}
              />
              {!!link.children?.length && (
                <div className="ml-6 border-l border-border pl-3">
                  <SortableList
                    items={link.children}
                    onReorder={(from, to) =>
                      edit(
                        (d) =>
                          void (d.nav.links[i]!.children = arrayMove(
                            d.nav.links[i]!.children ?? [],
                            from,
                            to
                          ))
                      )
                    }
                    testId={`nav-children-${i}`}
                    render={(child, j) => (
                      <LinkFields
                        link={child}
                        path={`nav.links[${i}].children[${j}]`}
                        errors={errors}
                        onChange={(patch) =>
                          edit((d) =>
                            Object.assign(d.nav.links[i]!.children![j]!, patch)
                          )
                        }
                        onRemove={() =>
                          edit((d) => {
                            d.nav.links[i]!.children!.splice(j, 1);
                            if (!d.nav.links[i]!.children!.length) {
                              delete d.nav.links[i]!.children;
                            }
                          })
                        }
                      />
                    )}
                  />
                </div>
              )}
              <button
                type="button"
                className="ml-6 text-xs text-primary hover:underline"
                onClick={() =>
                  edit(
                    (d) =>
                      void (d.nav.links[i]!.children ??= []).push({
                        _key: key(),
                        label: "New link",
                        href: "/",
                      })
                  )
                }
              >
                + Dropdown link
              </button>
            </div>
          )}
        />
        <AddButton
          label="Add nav link"
          testId="nav-add"
          onClick={() =>
            edit(
              (d) =>
                void d.nav.links.push({
                  _key: key(),
                  label: "New link",
                  href: "/",
                })
            )
          }
        />
      </Group>
      <Group
        title="Button"
        hint="The highlighted button at the end of the nav."
      >
        <div className="grid grid-cols-2 gap-3">
          <Text
            label="Label"
            value={doc.nav.cta.label}
            error={errors.get("nav.cta.label")}
            onChange={(v) => edit((d) => void (d.nav.cta.label = v))}
          />
          <Text
            label="Link"
            value={doc.nav.cta.href}
            error={errors.get("nav.cta.href")}
            onChange={(v) => edit((d) => void (d.nav.cta.href = v))}
          />
        </div>
      </Group>
    </div>
  );
}

function FooterSection({
  doc,
  edit,
  errors,
  confirmRemove,
}: SectionProps & { confirmRemove: ConfirmRemove }) {
  const f = doc.footer;
  return (
    <div className="space-y-6 py-4">
      <Group title="Company">
        <div className="grid grid-cols-2 gap-3">
          <Text
            label="Tagline"
            value={f.tagline}
            error={errors.get("footer.tagline")}
            onChange={(v) => edit((d) => void (d.footer.tagline = v))}
          />
          <Text
            label="Location"
            value={f.location}
            error={errors.get("footer.location")}
            onChange={(v) => edit((d) => void (d.footer.location = v))}
          />
        </div>
      </Group>
      <Group title="Link columns">
        <SortableList
          items={f.columns}
          onReorder={(from, to) =>
            edit(
              (d) =>
                void (d.footer.columns = arrayMove(d.footer.columns, from, to))
            )
          }
          testId="footer-columns"
          render={(col, i) => (
            <div className="flex-1 space-y-2">
              <div className="flex items-end gap-2">
                <Text
                  label="Column title"
                  value={col.title}
                  error={errors.get(`footer.columns[${i}].title`)}
                  onChange={(v) =>
                    edit((d) => void (d.footer.columns[i]!.title = v))
                  }
                />
                <RemoveButton
                  label={`Remove column ${col.title}`}
                  onClick={() =>
                    confirmRemove(
                      `the “${col.title}” column${col.links.length ? ` and its ${linkCount(col.links.length)}` : ""}`,
                      () =>
                        edit(
                          (d) =>
                            void (d.footer.columns = d.footer.columns.filter(
                              (c) => c._key !== col._key
                            ))
                        )
                    )
                  }
                />
              </div>
              <div className="ml-6 border-l border-border pl-3">
                <SortableList
                  items={col.links}
                  onReorder={(from, to) =>
                    edit(
                      (d) =>
                        void (d.footer.columns[i]!.links = arrayMove(
                          d.footer.columns[i]!.links,
                          from,
                          to
                        ))
                    )
                  }
                  testId={`footer-links-${i}`}
                  render={(link, j) => (
                    <LinkFields
                      link={link}
                      path={`footer.columns[${i}].links[${j}]`}
                      errors={errors}
                      onChange={(patch) =>
                        edit((d) =>
                          Object.assign(d.footer.columns[i]!.links[j]!, patch)
                        )
                      }
                      onRemove={() =>
                        edit(
                          (d) => void d.footer.columns[i]!.links.splice(j, 1)
                        )
                      }
                    />
                  )}
                />
                <AddButton
                  label="Add link"
                  onClick={() =>
                    edit(
                      (d) =>
                        void d.footer.columns[i]!.links.push({
                          _key: key(),
                          label: "New link",
                          href: "/",
                        })
                    )
                  }
                />
              </div>
            </div>
          )}
        />
        <AddButton
          label="Add column"
          onClick={() =>
            edit(
              (d) =>
                void d.footer.columns.push({
                  _key: key(),
                  title: "New column",
                  links: [],
                })
            )
          }
        />
      </Group>
      <Group
        hint="The footer leaves this column out while it has no lines."
        title="Text column"
      >
        <Text
          label="Title"
          value={f.highlights.title}
          error={errors.get("footer.highlights.title")}
          onChange={(v) => edit((d) => void (d.footer.highlights.title = v))}
        />
        <SortableList
          items={f.highlights.items}
          onReorder={(from, to) =>
            edit(
              (d) =>
                void (d.footer.highlights.items = arrayMove(
                  d.footer.highlights.items,
                  from,
                  to
                ))
            )
          }
          render={(item, i) => (
            <div className="flex flex-1 items-end gap-2">
              <Text
                label="Line"
                value={item.text}
                error={errors.get(`footer.highlights.items[${i}].text`)}
                onChange={(v) =>
                  edit((d) => void (d.footer.highlights.items[i]!.text = v))
                }
              />
              <RemoveButton
                label="Remove line"
                onClick={() =>
                  edit((d) => void d.footer.highlights.items.splice(i, 1))
                }
              />
            </div>
          )}
        />
        <AddButton
          label="Add line"
          onClick={() =>
            edit(
              (d) =>
                void d.footer.highlights.items.push({
                  _key: key(),
                  text: "New line",
                })
            )
          }
        />
      </Group>
      <Group title="Bottom bar">
        <Text
          label="Copyright (after © and the year)"
          value={f.copyright}
          error={errors.get("footer.copyright")}
          onChange={(v) => edit((d) => void (d.footer.copyright = v))}
        />
        <SortableList
          items={f.legalLinks}
          onReorder={(from, to) =>
            edit(
              (d) =>
                void (d.footer.legalLinks = arrayMove(
                  d.footer.legalLinks,
                  from,
                  to
                ))
            )
          }
          render={(link, i) => (
            <LinkFields
              link={link}
              path={`footer.legalLinks[${i}]`}
              errors={errors}
              onChange={(patch) =>
                edit((d) => Object.assign(d.footer.legalLinks[i]!, patch))
              }
              onRemove={() =>
                edit((d) => void d.footer.legalLinks.splice(i, 1))
              }
            />
          )}
        />
        <AddButton
          label="Add legal link"
          onClick={() =>
            edit(
              (d) =>
                void d.footer.legalLinks.push({
                  _key: key(),
                  label: "New link",
                  href: "/",
                })
            )
          }
        />
      </Group>
    </div>
  );
}

function SeoSection({ doc, edit, errors }: SectionProps) {
  const s = doc.seo;
  const img = s.defaultShareImage;
  return (
    <div className="space-y-6 py-4">
      <Group
        title="Title template"
        hint="%s is replaced by the page's SEO title (pages with an exact title skip the template). CMS pages only."
      >
        <Text
          label="Template"
          value={s.titleTemplate}
          error={errors.get("seo.titleTemplate")}
          onChange={(v) => edit((d) => void (d.seo.titleTemplate = v))}
          testId="seo-title-template"
        />
        <p className="text-xs text-muted-foreground">
          Example: {s.titleTemplate.replace("%s", () => "About us")}
        </p>
      </Group>
      <Group
        title="Default share image"
        hint="Used by CMS pages without a share image of their own. JPEG, PNG or WebP, ideally 1200×630."
      >
        <ImageField
          label=""
          accept={SHARE_IMAGE_TYPES}
          value={
            img.mediaId ? { mediaId: img.mediaId, alt: img.alt } : undefined
          }
          onChange={(v) =>
            edit((d) => {
              const cur = d.seo.defaultShareImage;
              d.seo.defaultShareImage = { url: cur.url, alt: cur.alt };
              if (!v) {
                // The alt described the removed library image, not the fallback: clear it.
                d.seo.defaultShareImage.alt = "";
                return;
              }
              Object.assign(d.seo.defaultShareImage, {
                mediaId: v.mediaId,
                alt: v.alt || cur.alt,
              });
              if (v.width && v.height) {
                Object.assign(d.seo.defaultShareImage, {
                  width: v.width,
                  height: v.height,
                });
              }
            })
          }
        />
        {!!img.mediaId && (
          <p
            className={`text-xs ${img.width === 1200 && img.height === 630 ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}`}
            data-testid="site-share-size"
          >
            {img.width && img.height
              ? `${img.width}×${img.height}${img.width === 1200 && img.height === 630 ? "" : " — platforms want 1200×630 and may crop this"}`
              : "Size unknown — pick it again to record it"}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Text
            label="Fallback URL (when no library image)"
            value={img.url}
            error={errors.get("seo.defaultShareImage.url")}
            onChange={(v) =>
              edit((d) => void (d.seo.defaultShareImage.url = v))
            }
          />
          <Text
            label="Alt text"
            value={img.alt}
            error={errors.get("seo.defaultShareImage.alt")}
            onChange={(v) =>
              edit((d) => void (d.seo.defaultShareImage.alt = v))
            }
          />
        </div>
      </Group>
      <Group title="twitter:card">
        <select
          className={inputClass}
          value={s.twitterCard}
          onChange={(e) =>
            edit(
              (d) =>
                void (d.seo.twitterCard = e.target
                  .value as SiteDoc["seo"]["twitterCard"])
            )
          }
        >
          <option value="summary_large_image">
            summary_large_image (big image)
          </option>
          <option value="summary">summary (small square image)</option>
        </select>
      </Group>
      <Group
        title="Organization"
        hint="Stored for the Organization structured data; not emitted on pages yet."
      >
        <div className="grid grid-cols-2 gap-3">
          <Text
            label="Name"
            value={s.organization.name}
            error={errors.get("seo.organization.name")}
            onChange={(v) => edit((d) => void (d.seo.organization.name = v))}
          />
          <Text
            label="URL"
            value={s.organization.url}
            error={errors.get("seo.organization.url")}
            onChange={(v) => edit((d) => void (d.seo.organization.url = v))}
          />
          <Text
            label="Logo URL"
            value={s.organization.logo}
            error={errors.get("seo.organization.logo")}
            onChange={(v) => edit((d) => void (d.seo.organization.logo = v))}
          />
        </div>
        <LinesField
          label="Profiles (sameAs), one URL per line"
          value={s.organization.sameAs}
          onChange={(lines) =>
            edit((d) => void (d.seo.organization.sameAs = lines))
          }
          errors={[...errors].filter(([p]) =>
            p.startsWith("seo.organization.sameAs")
          )}
        />
      </Group>
    </div>
  );
}

function SwatchesSection({ doc, edit, errors }: SectionProps) {
  return (
    <div className="space-y-6 py-4">
      <Group
        title="Brand swatches"
        hint="Saved custom colours, offered in the page editor's colour picker after the brand tokens."
      >
        {doc.swatches.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No custom colours yet.
          </p>
        )}
        <SortableList
          items={doc.swatches}
          onReorder={(from, to) =>
            edit((d) => void (d.swatches = arrayMove(d.swatches, from, to)))
          }
          testId="swatches"
          render={(sw, i) => (
            <div className="flex flex-1 items-end gap-2">
              <input
                type="color"
                aria-label="Pick colour"
                className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent"
                value={/^#[0-9a-f]{6}$/i.test(sw.hex) ? sw.hex : "#000000"}
                onChange={(e) =>
                  edit((d) => void (d.swatches[i]!.hex = e.target.value))
                }
              />
              <Text
                label="Hex"
                value={sw.hex}
                error={errors.get(`swatches[${i}].hex`)}
                onChange={(v) => edit((d) => void (d.swatches[i]!.hex = v))}
              />
              <Text
                label="Name (optional)"
                value={sw.name ?? ""}
                error={errors.get(`swatches[${i}].name`)}
                onChange={(v) =>
                  edit((d) => {
                    if (v) {
                      d.swatches[i]!.name = v;
                    } else {
                      delete d.swatches[i]!.name;
                    }
                  })
                }
              />
              <RemoveButton
                label="Remove swatch"
                onClick={() => edit((d) => void d.swatches.splice(i, 1))}
              />
            </div>
          )}
        />
        <AddButton
          label="Add swatch"
          testId="swatch-add"
          onClick={() =>
            edit((d) => void d.swatches.push({ _key: key(), hex: "#888888" }))
          }
        />
      </Group>
    </div>
  );
}

// --- history and publish -------------------------------------------------------------------------

const KIND_LABEL: Record<SiteRevisionItem["kind"], string> = {
  autosnapshot: "Autosave",
  named: "Named",
  published: "Published",
  restore: "Restored",
};

function HistorySection({
  draftVersion,
  beforeRestore,
  onRestored,
}: {
  draftVersion: () => number;
  beforeRestore: () => Promise<boolean>;
  onRestored: (state: SiteEditorState) => void;
}) {
  const [items, setItems] = useState<SiteRevisionItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (from?: string) => {
    const res = await signedOutAsResult(() =>
      getTrpc().cms.site.siteHistory.query(from ? { cursor: from } : {})
    );
    if (!res.ok) {
      return setError(res.message);
    }
    setItems((prev) => {
      const seen = new Set((from ? (prev ?? []) : []).map((r) => r.id));
      return [
        ...(from ? (prev ?? []) : []),
        ...res.revisions.filter((r) => !seen.has(r.id)),
      ];
    });
    setCursor(res.nextCursor);
  }, []);

  useEffect(() => void load(), [load]);

  const restore = async (revId: string) => {
    setBusy(revId);
    setError(null);
    if (!(await beforeRestore())) {
      setBusy(null);
      return setError("Fix or save the current draft first.");
    }
    const res = await signedOutAsResult(() =>
      getTrpc().cms.site.restoreSite.mutate({
        revId,
        draftVersion: draftVersion(),
      })
    );
    setBusy(null);
    if (!res.ok) {
      return setError(res.message);
    }
    onRestored(res);
  };

  if (error) {
    return <p className="py-4 text-sm text-destructive">{error}</p>;
  }
  if (!items) {
    return <p className="py-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (!items.length) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        No versions yet: the site uses its built-in defaults. Your first edit
        starts the history.
      </p>
    );
  }
  return (
    <div className="py-4">
      <ul
        className="divide-y divide-border rounded border border-border"
        data-testid="site-history"
      >
        {items.map((r) => (
          <li
            key={r.id}
            className="flex items-start gap-3 px-3 py-2 text-sm"
            data-testid="site-history-row"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {KIND_LABEL[r.kind]}
                </span>
                {!!r.isLive && (
                  <span className="rounded bg-emerald-700/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    Live
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                  {r.byYou ? " · you" : ""}
                </span>
              </div>
              {!!r.label && (
                <p
                  className="mt-1 break-words font-semibold text-foreground"
                  data-testid="site-history-label"
                >
                  {r.label}
                </p>
              )}
              <p className="mt-1 break-words text-muted-foreground">
                {r.summary}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void restore(r.id)}
              data-testid="site-restore"
            >
              <RotateCcw /> Restore
            </Button>
          </li>
        ))}
      </ul>
      {!!cursor && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => void load(cursor)}
        >
          Load older versions
        </Button>
      )}
    </div>
  );
}

function PublishDialog({
  open,
  onOpenChange,
  changes,
  draftVersion,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  changes: string[];
  draftVersion: () => number;
  onPublished: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);

  const run = async (call: () => Promise<AdminResult<SitePublishResult>>) => {
    setBusy(true);
    setError(null);
    const res = await signedOutAsResult(call);
    setBusy(false);
    if (!res.ok) {
      return setError(res.message);
    }
    if (!res.live) {
      setRetry(true);
      return setError(
        "Published, but not live yet: the site couldn't be updated. Retry."
      );
    }
    setRetry(false);
    onOpenChange(false);
    onPublished(
      "Site settings published. Every page shows them within a minute."
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="site-publish-dialog">
        <DialogHeader>
          <DialogTitle>Publish site settings</DialogTitle>
          <DialogDescription>
            These changes go live on every page.
          </DialogDescription>
        </DialogHeader>
        <ul
          className="max-h-64 list-disc space-y-1 overflow-y-auto pl-5 text-sm"
          data-testid="site-publish-changes"
        >
          {changes.length ? (
            changes.map((c, i) => <li key={i}>{c}</li>)
          ) : (
            <li>No changes against the live settings.</li>
          )}
        </ul>
        {!!error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {retry ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(() => getTrpc().cms.site.republishSite.mutate())
              }
            >
              Retry
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  getTrpc().cms.site.publishSite.mutate({
                    draftVersion: draftVersion(),
                  })
                )
              }
              data-testid="site-publish-confirm"
            >
              {busy ? "Publishing…" : "Publish"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SaveVersionDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves to an error message, or null when saved. */
  onSubmit: (label: string) => Promise<string | null>;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setLabel("");
      setError(null);
    }
  }, [open]);
  const valid =
    label.trim().length > 0 && label.trim().length <= MAX_VERSION_LABEL;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className="max-w-md sm:max-w-md"
        data-testid="site-save-version-dialog"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid || busy) {
              return;
            }
            setBusy(true);
            const err = await onSubmit(label.trim());
            setBusy(false);
            if (err) {
              setError(err);
            } else {
              onOpenChange(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Save version</DialogTitle>
            <DialogDescription>
              Keeps the site settings as they are now under a name, so you can
              find them in History.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={label}
            maxLength={MAX_VERSION_LABEL}
            placeholder="e.g. Before the menu rework"
            onChange={(e) => setLabel(e.target.value)}
            data-testid="site-save-version-input"
          />
          {!!error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="submit"
              disabled={!valid || busy}
              data-testid="site-save-version-submit"
            >
              {busy ? "Saving…" : "Save version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const MAX_VERSION_LABEL = 80;

function RemoveDialog({
  removal,
  onClose,
  onConfirm,
}: {
  removal: Removal | null;
  onClose: () => void;
  /** Resolves to an error message, or null when removed. */
  onConfirm: (r: Removal) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [removal]);
  return (
    <AlertDialog
      open={removal !== null}
      onOpenChange={(open) => !(open || busy) && onClose()}
    >
      <AlertDialogContent data-testid="site-remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {removal?.what}?</AlertDialogTitle>
          <AlertDialogDescription>
            The settings as they are now are kept in History first, so you can
            restore them. The live site doesn't change until you publish.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!!error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="site-remove-confirm"
            onClick={async () => {
              if (!removal) {
                return;
              }
              setBusy(true);
              const err = await onConfirm(removal);
              setBusy(false);
              if (err) {
                setError(err);
              } else {
                onClose();
              }
            }}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- small pieces --------------------------------------------------------------------------------

const inputClass =
  "w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded border border-border bg-card/50 p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {!!hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  error,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  testId?: string;
}) {
  return (
    <label className="block min-w-0 flex-1 space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="text"
        className={`${inputClass} ${error ? "border-destructive" : ""}`}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      {!!error && (
        <span className="block text-xs text-destructive">{error}</span>
      )}
    </label>
  );
}

function LinkFields({
  link,
  path,
  errors,
  onChange,
  onRemove,
}: {
  link: SiteLink;
  path: string;
  errors: Map<string, string>;
  onChange: (patch: Partial<SiteLink>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-1 items-end gap-2" data-testid="site-link">
      <Text
        label="Label"
        value={link.label}
        error={errors.get(`${path}.label`)}
        onChange={(label) => onChange({ label })}
      />
      <Text
        label="Link"
        value={link.href}
        error={errors.get(`${path}.href`)}
        onChange={(href) => onChange({ href })}
      />
      <RemoveButton label={`Remove ${link.label}`} onClick={onRemove} />
    </div>
  );
}

/** A list of strings edited as lines of text; empty lines are dropped (an emptied field is an empty list). */
function LinesField({
  label,
  value,
  onChange,
  errors,
}: {
  label: string;
  value: string[];
  onChange: (lines: string[]) => void;
  errors: [string, string][];
}) {
  const [text, setText] = useState(() => value.join("\n"));
  const lines = (t: string) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  // A change from elsewhere (restore) replaces the text; typing (a trailing newline) doesn't.
  useEffect(() => {
    setText((t) =>
      lines(t).join("\n") === value.join("\n") ? t : value.join("\n")
    );
  }, [value]);
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <textarea
        className={`${inputClass} h-20`}
        value={text}
        data-testid="site-sameas"
        onChange={(e) => {
          setText(e.target.value);
          onChange(lines(e.target.value));
        }}
      />
      {errors.map(([p, m]) => (
        <span key={p} className="block text-xs text-destructive">
          {m}
        </span>
      ))}
    </label>
  );
}

function AddButton({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      data-testid={testId}
    >
      <Plus /> {label}
    </Button>
  );
}

function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="mb-1 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

/** A vertical list reordered by dragging the grip (pointer or keyboard: focus the grip, Space, arrows, Space). */
function SortableList<T extends { _key: string }>({
  items,
  onReorder,
  render,
  testId,
}: {
  items: T[];
  onReorder: (from: number, to: number) => void;
  render: (item: T, index: number) => ReactNode;
  testId?: string;
}) {
  // A stable id: dnd-kit's own counter differs between the server render and hydration.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }
    const from = items.findIndex((it) => it._key === active.id);
    const to = items.findIndex((it) => it._key === over.id);
    if (from >= 0 && to >= 0) {
      onReorder(from, to);
    }
  };
  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={items.map((it) => it._key)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-2" data-testid={testId}>
          {items.map((item, i) => (
            <SortableRow key={item._key} id={item._key}>
              {render(item, i)}
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={`flex items-start gap-1 rounded ${isDragging ? "bg-muted opacity-80 shadow-lg" : ""}`}
      data-key={id}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        className="mt-7 cursor-grab rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </li>
  );
}
