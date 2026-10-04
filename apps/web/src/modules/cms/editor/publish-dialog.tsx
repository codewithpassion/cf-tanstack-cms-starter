// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited, as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, refetch keys), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/suspicious/noArrayIndexKey: the list is rebuilt per render from a fixed array with no ids and is never reordered.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs), as in the source.

import { getBlockDef } from "@repo/cms-core/blocks/registry";
import { type BlockChange, diffDocs } from "@repo/cms-core/editor/diff";
import { publishSummary } from "@repo/cms-core/editor/publish-summary";
import { slugToPath } from "@repo/cms-core/paths";
import { withReadingTime } from "@repo/cms-core/posts";
import type { PageDoc } from "@repo/cms-core/types";
import { AlertTriangle, Info, Loader2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { getTrpc } from "#/integrations/trpc/client";
import { FieldList } from "./history-panel";
import { signedOutAsResult } from "./signed-out";
import { useEditorState, useEditorStore } from "./use-editor-store";

/**
 * "Publish" confirmation (docs/cms-plan.md §3.6): what changes against the LIVE revision (blocks
 * added, removed, changed with their field paths, moved; SEO and post fields), a one-line summary,
 * and any `warnings` (the SEO checklist plugs in here). Publishing itself is the caller's
 * `onPublish` (the editor store's publish, which saves pending edits first).
 */

/** A check to show before publishing. Shown only; none of them blocks publishing. */
export type PublishWarning = {
  level: "error" | "warning" | "info";
  message: string;
};

type LiveState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; live: { revId: string; doc: PageDoc } | null };

const blockLabel = (type: string) => getBlockDef(type)?.label ?? type;

const STATUS_TEXT: Record<BlockChange["status"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  moved: "Moved",
};

const STATUS_DOT: Record<BlockChange["status"], string> = {
  added: "bg-green-500",
  changed: "bg-amber-500",
  moved: "bg-blue-400",
  removed: "bg-red-500",
};

const WARNING_STYLE: Record<
  PublishWarning["level"],
  { Icon: typeof Info; cls: string }
> = {
  error: { Icon: XCircle, cls: "text-destructive" },
  warning: { Icon: AlertTriangle, cls: "text-amber-700 dark:text-amber-300" },
  info: { Icon: Info, cls: "text-muted-foreground" },
};

export function PublishDialog({
  open,
  onOpenChange,
  pageId,
  warnings = [],
  onPublish,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
  warnings?: PublishWarning[];
  /**
   * Publishes; resolves true when the page was published, and the dialog then closes. Gets the
   * live revision id the diff was made against (null: not live), or undefined when the live page
   * couldn't be loaded; the server refuses with LIVE_CHANGED when it moved since.
   */
  onPublish: (expectedLiveRevId: string | null | undefined) => Promise<boolean>;
}) {
  const store = useEditorStore();
  const { doc, publishing } = useEditorState();
  const [live, setLive] = useState<LiveState>({ status: "loading" });
  const [reload, setReload] = useState(0);

  // Opening starts from "loading" in the same render, so the previous opening's diff never shows.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLive({ status: "loading" });
    }
  }

  // The live revision as it is now: a publish or rollback since the editor opened moves it.
  useEffect(() => {
    if (!open) {
      return;
    }
    store.flushEdits(); // In-progress inline and rich-text edits belong in the comparison.
    let cancelled = false;
    setLive({ status: "loading" });
    signedOutAsResult(() => getTrpc().cms.preview.getLiveDoc.query({ pageId }))
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (res.ok) {
          setLive({
            status: "ready",
            live: res.live
              ? {
                  revId: res.live.revId,
                  doc: JSON.parse(res.live.docJson) as PageDoc,
                }
              : null,
          });
        } else {
          setLive({ status: "error", message: res.message });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLive({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, pageId, store, reload]);

  // A post's reading time is computed by the server on save; the editor's copy may lag behind it.
  const diff = useMemo(
    () =>
      live.status === "ready" && live.live
        ? diffDocs(live.live.doc, withReadingTime(doc))
        : null,
    [live, doc]
  );
  const firstPublish = live.status === "ready" && !live.live;

  const publish = async () => {
    const expected =
      live.status === "ready" ? (live.live?.revId ?? null) : undefined;
    if (await onPublish(expected)) {
      onOpenChange(false);
    }
    // Not published (e.g. LIVE_CHANGED): compare with the live page as it is now.
    else {
      setReload((n) => n + 1);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 border-border sm:max-w-2xl bg-card text-foreground"
        data-testid="publish-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {firstPublish ? "First publish" : "Publish changes"}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {firstPublish
              ? "This page isn't live yet. Publishing puts it"
              : "Publishing replaces the live page"}{" "}
            at{" "}
            <span className="font-mono text-muted-foreground">
              {slugToPath(doc.seo.slug)}
            </span>
            .
          </DialogDescription>
        </DialogHeader>

        {live.status === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Comparing
            with the live page…
          </p>
        )}
        {live.status === "error" && (
          <p
            className="text-sm text-amber-700 dark:text-amber-300"
            role="alert"
          >
            Couldn't load the live page to compare ({live.message}). You can
            still publish.
          </p>
        )}
        {live.status === "ready" && (
          <>
            <p className="text-sm font-medium" data-testid="publish-summary">
              {publishSummary(diff, doc.blocks.length)}
            </p>
            {!!diff?.changed && (
              <div
                className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto pr-1 text-sm"
                data-testid="publish-diff"
              >
                {diff.blocks.map((change) => (
                  <div
                    key={change.key}
                    className="rounded border border-border p-2"
                    data-testid="publish-diff-block"
                    data-status={change.status}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[change.status]}`}
                        aria-hidden
                      />
                      <span className="min-w-0 truncate font-medium">
                        {blockLabel(change.type)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {STATUS_TEXT[change.status]}
                        {change.status === "changed" && change.moved
                          ? " · moved"
                          : ""}
                      </span>
                    </div>
                    {change.status === "changed" && (
                      <FieldList fields={change.fields} />
                    )}
                  </div>
                ))}
                {diff.seo.length > 0 && (
                  <div
                    className="rounded border border-border p-2"
                    data-testid="publish-diff-seo"
                  >
                    <div className="font-medium">SEO</div>
                    <FieldList fields={diff.seo} />
                  </div>
                )}
                {diff.post.length > 0 && (
                  <div className="rounded border border-border p-2">
                    <div className="font-medium">Post details</div>
                    <FieldList fields={diff.post} />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {warnings.length > 0 && (
          <ul
            className="flex flex-col gap-1 rounded border border-border p-2 text-sm"
            data-testid="publish-warnings"
          >
            {warnings.map((w, i) => {
              const { Icon, cls } = WARNING_STYLE[w.level];
              return (
                <li key={i} className={`flex items-start gap-2 ${cls}`}>
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-label={w.level}
                  />
                  <span>{w.message}</span>
                </li>
              );
            })}
          </ul>
        )}

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
            onClick={() => void publish()}
            disabled={publishing || live.status === "loading"}
            data-testid="publish-confirm"
          >
            {publishing ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
