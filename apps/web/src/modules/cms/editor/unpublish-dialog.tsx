import { type MouseEvent, useCallback, useState } from "react";
import { toast } from "sonner";
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
import { getTrpc } from "#/integrations/trpc/client";
import { signedOutAsResult } from "./signed-out";

/** What to unpublish: the editor's page or a row of /admin/pages or /admin/posts. */
export type UnpublishTarget = {
  id: string;
  kind: "page" | "post";
  path: string;
};

/**
 * Confirms, then takes a page or post off the site (its draft and history stay). Shared by the
 * editor's top bar and the pages and posts lists. `onDone` runs after a successful unpublish.
 */
export function UnpublishDialog({
  target,
  onClose,
  onDone,
}: {
  target: UnpublishTarget | null;
  onClose: () => void;
  /** May return a promise (e.g. a router invalidate); it is awaited. */
  onDone: () => unknown;
}) {
  const [busy, setBusy] = useState(false);
  // Unpublished in D1, but the site's page store didn't update: the dialog stays open to retry.
  const [unsynced, setUnsynced] = useState(false);
  const noun = target?.kind === "post" ? "post" : "page";

  const unpublish = useCallback(async () => {
    if (!target) {
      return;
    }
    setBusy(true);
    try {
      const res = await signedOutAsResult(() =>
        getTrpc().cms.pages.unpublishPage.mutate({ pageId: target.id })
      );
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome can't see the AdminError arm of the server function's result type.
      if (!res.ok) {
        toast.error(`Not unpublished: ${res.message}`);
        return;
      }
      if (!res.synced) {
        setUnsynced(true);
        return;
      }
      setUnsynced(false);
      toast(`Unpublished ${target.path}`);
      onClose();
      await onDone();
    } catch (err) {
      toast.error(
        `Not unpublished: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(false);
    }
  }, [target, onClose, onDone]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open || busy) {
        return;
      }
      onClose();
      // Closed after a partial unpublish: the page may still be served, so the caller keeps
      // showing it as published (and its Unpublish button) rather than refreshing.
      if (unsynced) {
        setUnsynced(false);
        toast.error(`${target?.path} may still show on the site`, {
          description: "Click Unpublish again to clear the site's page store.",
        });
      }
    },
    [busy, onClose, target, unsynced]
  );
  // The action closes the dialog by default; keep it open until the call returns.
  const onConfirm = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      return unpublish();
    },
    [unpublish]
  );

  return (
    <AlertDialog onOpenChange={onOpenChange} open={target !== null}>
      <AlertDialogContent
        className="border-border bg-card text-foreground"
        data-testid="unpublish-confirm"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Unpublish this {noun}?</AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            <span className="font-mono">{target?.path}</span> leaves the site
            straight away and drops out of the sitemap and llms.txt. The draft
            and its history stay, so you can publish it again.
          </AlertDialogDescription>
          {unsynced ? (
            <p
              className="text-destructive text-sm"
              data-testid="unpublish-unsynced"
            >
              The {noun} is unpublished, but the site's page store didn't
              update, so it may still show. Click Unpublish to try again.
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="border-border bg-transparent"
            disabled={busy}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-unpublish"
            disabled={busy}
            onClick={onConfirm}
            variant="destructive"
          >
            {busy ? "Unpublishing…" : "Unpublish"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
