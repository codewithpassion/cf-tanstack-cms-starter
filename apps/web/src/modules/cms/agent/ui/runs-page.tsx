// biome-ignore-all lint/a11y/noLabelWithoutControl: the revert label wraps the checkbox it names, or a spacer when the page can't be reverted (biome does not see through the conditional).
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source UI; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/suspicious/noArrayIndexKey: lists rebuilt per render from fixed arrays with no ids (variants, warnings, errors), never reordered.
import { proposedDoc } from "@repo/cms-core/agent/changeset";
import { formatUsd } from "@repo/cms-core/agent/cost";
import { PROVIDER_LABEL } from "@repo/cms-core/agent/models";
import {
  type RevertAction,
  type Run,
  type RunItem,
  type RunItemStatus,
  revertsByDefault,
  runCounts,
} from "@repo/cms-core/agent/run";
import { plainTitle } from "@repo/cms-core/agent/thread-title";
import type { Changeset, ThreadSummary } from "@repo/cms-core/agent/types";
import { diffDocs } from "@repo/cms-core/editor/diff";
import { formatDateTime } from "@repo/cms-core/format-date";
import type { PageDoc } from "@repo/cms-core/types";
import type { RunPageRef } from "@repo/services/agent/admin-service";
import { Bot, Check, ExternalLink, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { goToLogin, isUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import { FieldList } from "../../editor/history-panel";

/**
 * /admin/agent (docs/cms-plan.md §3.2, §4.4 "Site-wide"): every site-wide run with its status and
 * total, and for the selected run the review queue: per page what it proposed (accept or reject
 * the page's proposals here, with each one's changes shown inline, or review them block by block on
 * the page's canvas), the drafts it created, and "Revert this run" with a confirmation listing
 * every page it will touch (pages edited after the run start unticked). Nothing here publishes.
 */

type Detail = {
  run: Run;
  changesets: Changeset[];
  pages: RunPageRef[];
  thread: { id: string; title: string; pageId: string } | null;
};

const agentRuns = () => getTrpc().cms.agentRuns;

const revertPreview = (runId: string) =>
  agentRuns().revertPreview.query({ runId });

/** A failed call's message; a signed-out admin goes to the login page and back. */
function failure(err: unknown): string {
  if (isUnauthorized(err)) {
    goToLogin(window.location.pathname + window.location.search);
  }
  return err instanceof Error ? err.message : String(err);
}

/** A run action's result: the run after it, or why it was refused. */
type RunActionResult = { ok: true } | { ok: false; message: string };

const ITEM_STYLE: Record<RunItemStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-sky-800/60 text-sky-100",
  proposed: "bg-violet-800/60 text-violet-100",
  accepted:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-700 dark:text-emerald-300",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-600 dark:text-red-400",
  skipped: "bg-muted text-muted-foreground",
  failed:
    "bg-amber-500/15 text-amber-700 dark:text-amber-700 dark:text-amber-300",
};
const ITEM_LABEL: Record<RunItemStatus, string> = {
  pending: "waiting",
  running: "working",
  proposed: "to review",
  accepted: "accepted",
  rejected: "rejected",
  skipped: "skipped",
  failed: "failed",
};

function runLabel(run: Run): string {
  if (run.revertedAt) {
    return "reverted";
  }
  if (run.status === "active") {
    return "paused";
  }
  if (run.status === "proposed") {
    return "plan";
  }
  return run.status;
}

export function RunsPage({
  runs: initialRuns,
  threads,
  selected,
  onSelect,
}: {
  runs: Run[];
  threads: ThreadSummary[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  useEffect(() => setRuns(initialRuns), [initialRuns]);
  const titles = useMemo(
    () => new Map(threads.map((t) => [t.id, t.title])),
    [threads]
  );
  const shown = runs.filter(
    (r) => r.status !== "superseded" && r.status !== "discarded"
  );
  const update = useCallback(
    (run: Run) =>
      setRuns((list) => list.map((r) => (r.id === run.id ? run : r))),
    []
  );

  return (
    <div className="p-4 md:p-8" data-testid="agent-runs-page">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-bold">Agent runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Site-wide work by the AI agent: plan, progress and the review queue.
          Start a run from the AI tab of any page (switch to Site). The agent
          never publishes.
        </p>
      </div>
      {shown.length ? (
        <div className="overflow-hidden rounded border border-border">
          <table
            className="w-full text-left text-sm [overflow-wrap:normal]"
            data-testid="agent-runs-table"
          >
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Run</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">
                  Pages
                </th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">
                  Total
                </th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">
                  Started
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const c = runCounts(r);
                return (
                  <tr
                    key={r.id}
                    className={`cursor-pointer border-t border-border hover:bg-card ${selected === r.id ? "bg-card" : ""}`}
                    onClick={() => onSelect(r.id)}
                    data-testid="agent-runs-row"
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium text-foreground">
                        {r.summary}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {plainTitle(titles.get(r.threadId) ?? "Conversation")} ·{" "}
                        {PROVIDER_LABEL[r.provider]}
                      </div>
                      {/* Below md the Pages, Total and Started columns fold into this line. */}
                      <div className="mt-0.5 text-xs text-muted-foreground md:hidden">
                        {r.items.length}{" "}
                        {r.items.length === 1 ? "page" : "pages"}
                        {c.proposed ? ` (${c.proposed} to review)` : ""} ·{" "}
                        {formatUsd(r.costUsd)} · {formatDateTime(r.createdAt)}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-muted px-2 py-0.5 text-xs">
                        {runLabel(r)}
                      </span>
                    </td>
                    <td className="hidden px-4 py-2 text-muted-foreground md:table-cell">
                      {r.items.length}
                      {c.proposed ? (
                        <span className="ml-1 text-violet-300">
                          ({c.proposed} to review)
                        </span>
                      ) : null}
                    </td>
                    <td className="hidden px-4 py-2 text-muted-foreground md:table-cell">
                      {formatUsd(r.costUsd)}
                    </td>
                    <td className="hidden px-4 py-2 text-muted-foreground md:table-cell">
                      {formatDateTime(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted-foreground" data-testid="agent-runs-empty">
          No runs yet.
        </p>
      )}
      {!!selected && (
        <RunDetail
          key={selected}
          runId={selected}
          onChange={update}
          onClose={() => onSelect(null)}
        />
      )}
    </div>
  );
}

function RunDetail({
  runId,
  onChange,
  onClose,
}: {
  runId: string;
  onChange: (run: Run) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await agentRuns().getRun.query({ runId });
      if (!res.ok) {
        return setError(res.message);
      }
      const d: Detail = res.detail;
      setDetail(d);
      onChange(d.run);
    } catch (err) {
      setError(failure(err));
    }
  }, [runId, onChange]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, call: () => Promise<RunActionResult>) => {
    setBusy(key);
    setError(null);
    try {
      const res = await call();
      if (!res.ok) {
        setError(res.message);
      }
      await load();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(null);
    }
  };

  if (error && !detail) {
    return (
      <p className="mt-6 text-sm text-red-600 dark:text-red-400">{error}</p>
    );
  }
  if (!detail) {
    return (
      <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the run…
      </p>
    );
  }
  const { run, changesets, pages, thread } = detail;
  const page = (id?: string) =>
    id ? pages.find((p) => p.id === id) : undefined;
  const counts = runCounts(run);
  const canRevert =
    !run.revertedAt &&
    (run.status === "active" ||
      run.status === "done" ||
      run.status === "cancelled") &&
    run.items.some(
      (i) => i.revisionIds.length || i.createdPageId || i.changesetIds.length
    );
  const resumeHref = thread
    ? `/admin/editor/${thread.pageId}?agent=site&thread=${encodeURIComponent(thread.id)}`
    : null;

  return (
    <section
      className="mt-8 rounded border border-border bg-card/40 p-5"
      data-testid="agent-run-detail"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{run.summary}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {runLabel(run)} · {run.items.length} pages ·{" "}
            {PROVIDER_LABEL[run.provider]} {run.model} · started{" "}
            {formatDateTime(run.createdAt)}
            {run.approvedAt
              ? ` · approved ${formatDateTime(run.approvedAt)}`
              : ""}
          </p>
          {!!run.revertedAt && (
            <p
              className="mt-1 text-xs text-amber-700 dark:text-amber-300"
              data-testid="agent-run-reverted"
            >
              Reverted {formatDateTime(run.revertedAt)}
              {run.revertedBy ? ` by ${run.revertedBy}` : ""}
            </p>
          )}
        </div>
        <div className="text-right">
          <div
            className="text-sm text-foreground"
            data-testid="agent-run-detail-total"
          >
            Run total {formatUsd(run.costUsd)}
          </div>
          <div className="text-xs text-muted-foreground">
            {counts.accepted} accepted · {counts.proposed} to review ·{" "}
            {counts.pending + counts.running} waiting
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {!!resumeHref && (
          <a
            href={resumeHref}
            className="inline-flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="agent-run-open-thread"
          >
            <Bot className="h-4 w-4" />{" "}
            {run.status === "active" && counts.pending + counts.running
              ? "Resume in the editor"
              : "Open the conversation"}
          </a>
        )}
        {!!canRevert && <RevertButton run={run} onDone={load} />}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {!!error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <h3 className="mt-6 mb-2 text-sm font-medium text-muted-foreground">
        Review queue
      </h3>
      <ul className="space-y-2" data-testid="agent-review-queue">
        {run.items.map((item, n) => (
          <QueueItem
            key={item.id}
            n={n + 1}
            run={run}
            item={item}
            page={page(item.pageId) ?? page(item.createdPageId)}
            created={page(item.createdPageId)}
            changesets={changesets.filter(
              (c) =>
                item.changesetIds.includes(c.id) && c.status !== "superseded"
            )}
            busy={busy}
            onReview={(decision, variant) =>
              act(item.id, () =>
                agentRuns().reviewRunItem.mutate({
                  runId: run.id,
                  itemId: item.id,
                  decision,
                  ...(variant !== undefined && { variant }),
                })
              )
            }
            onRetry={() =>
              act(item.id, () =>
                agentRuns().retryRunItem.mutate({
                  runId: run.id,
                  itemId: item.id,
                })
              )
            }
          />
        ))}
      </ul>
    </section>
  );
}

function QueueItem({
  n,
  run,
  item,
  page,
  created,
  changesets,
  busy,
  onReview,
  onRetry,
}: {
  n: number;
  run: Run;
  item: RunItem;
  page: RunPageRef | undefined;
  created: RunPageRef | undefined;
  changesets: Changeset[];
  busy: string | null;
  onReview: (decision: "accept" | "reject", variant?: number) => void;
  onRetry: () => void;
}) {
  // No default: an SEO proposal is accepted with the option the user picked.
  const [variant, setVariant] = useState<number | null>(null);
  const seo = changesets.find(
    (c) => c.kind === "seo" && c.status === "pending" && c.seo
  );
  const reviewable = item.status === "proposed" && !run.revertedAt;
  const working = busy === item.id;
  return (
    <li
      className="rounded border border-border bg-background/60 p-3 text-sm"
      data-testid="agent-queue-item"
      data-slug={item.slug}
      data-status={item.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{n}.</span>
        <span className="rounded bg-muted px-1.5 text-[11px] uppercase text-muted-foreground">
          {item.action}
        </span>
        {page ? (
          <a
            href={`/admin/editor/${page.id}`}
            className="font-mono text-foreground hover:text-primary"
          >
            /{item.slug}
          </a>
        ) : (
          <span className="font-mono text-muted-foreground">/{item.slug}</span>
        )}
        {!!item.from && (
          <span className="text-xs text-muted-foreground">
            copy of /{item.from}
          </span>
        )}
        <span
          className={`ml-auto rounded px-1.5 text-[10px] uppercase ${ITEM_STYLE[item.status]}`}
        >
          {ITEM_LABEL[item.status]}
        </span>
        {item.costUsd > 0 && (
          <span className="text-xs text-muted-foreground">
            {formatUsd(item.costUsd)}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{item.intent}</p>
      {!!item.note && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          {item.note}
        </p>
      )}
      {!!created && (
        <p className="mt-2 text-xs" data-testid="agent-queue-draft">
          <span className="text-muted-foreground">New draft: </span>
          <a
            href={`/admin/editor/${created.id}`}
            className="text-emerald-700 dark:text-emerald-300 hover:underline"
          >
            {created.title} (/{created.slug})
          </a>
          <span className="ml-1 text-muted-foreground">
            · {created.status === "draft" ? "not published" : created.status}
          </span>
        </p>
      )}
      {changesets.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {changesets.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2"
              data-testid="agent-queue-proposal"
            >
              <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                {c.kind === "seo" ? "SEO" : "changes"}
              </span>
              <span className="text-foreground">{c.summary}</span>
              <span className="text-muted-foreground">· {c.status}</span>
              {c.status === "pending" && page && c.kind === "ops" && (
                <a
                  href={`/admin/editor/${c.pageId}?review=${encodeURIComponent(c.id)}`}
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  data-testid="agent-queue-open"
                >
                  Review on canvas <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {c.status === "pending" && c.kind === "ops" && (
                <ProposalDiff cs={c} />
              )}
            </li>
          ))}
        </ul>
      )}
      {!!seo && reviewable && (
        <fieldset className="mt-2 space-y-1 text-xs">
          <legend className="mb-1 text-muted-foreground">
            SEO title and description
          </legend>
          {seo.seo!.variants.map((v, i) => (
            <label
              key={i}
              className={`block cursor-pointer rounded border p-1.5 ${variant === i ? "border-violet-500 bg-violet-900/20" : "border-border"}`}
            >
              <input
                type="radio"
                className="mr-2"
                checked={variant === i}
                onChange={() => setVariant(i)}
              />
              <span className="text-sky-300">{v.title}</span>
              <span className="block text-muted-foreground">
                {v.description}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {!!reviewable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!!busy || (!!seo && variant === null)}
            onClick={() =>
              onReview("accept", seo ? (variant ?? undefined) : undefined)
            }
            data-testid="agent-queue-accept"
          >
            {working ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}{" "}
            Accept
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() => onReview("reject")}
            data-testid="agent-queue-reject"
          >
            <X className="h-3.5 w-3.5" /> Reject
            {created?.status === "draft" ? " (archives the draft)" : ""}
          </Button>
          {seo && variant === null && (
            <span
              className="text-xs text-muted-foreground"
              data-testid="agent-queue-pick-seo"
            >
              Pick a title option to accept.
            </span>
          )}
        </div>
      )}
      {(item.status === "failed" || item.status === "skipped") &&
        (run.status === "active" || run.status === "done") &&
        !run.revertedAt && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            disabled={!!busy}
            onClick={onRetry}
            data-testid="agent-queue-retry"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Run again (resume the run in
            the editor)
          </Button>
        )}
    </li>
  );
}

/** An `ops` proposal's changes, block by block, as History shows them. */
function ProposalDiff({ cs }: { cs: Changeset }) {
  const diff = useMemo(() => {
    if (!(cs.ops && cs.baseDocJson)) {
      return null;
    }
    const base = JSON.parse(cs.baseDocJson) as PageDoc;
    try {
      return diffDocs(base, proposedDoc(base, cs.ops));
    } catch {
      return null;
    }
  }, [cs]);
  if (!diff) {
    return null;
  }
  return (
    <div
      className="w-full space-y-1 rounded border border-border bg-card/60 p-2"
      data-testid="agent-queue-diff"
    >
      {diff.blocks.map((b) => (
        <div key={`${b.status}:${b.key}`}>
          <span className="text-foreground">{b.type}</span>{" "}
          <span className="text-muted-foreground">
            {b.status === "changed"
              ? b.moved
                ? "changed · moved"
                : "changed"
              : b.status}
          </span>
          {b.status === "changed" && <FieldList fields={b.fields} />}
        </div>
      ))}
      {diff.seo.length > 0 && (
        <div>
          <span className="text-foreground">SEO</span>
          <FieldList fields={diff.seo} />
        </div>
      )}
      {diff.post.length > 0 && (
        <div>
          <span className="text-foreground">Post details</span>
          <FieldList fields={diff.post} />
        </div>
      )}
      {!diff.changed && (
        <p className="text-muted-foreground">No visible change.</p>
      )}
    </div>
  );
}

const ACTION_TEXT: Record<RevertAction["kind"], string> = {
  restore: "Restore",
  archive: "Archive",
  skip: "Leave",
};

/**
 * "Revert this run": a confirmation listing what happens to each page, each with a checkbox. A page
 * edited after the run starts unticked: restoring it would replace those edits (they stay in
 * History). Pages whose run changes are live get a note: the revert changes drafts only.
 */
function RevertButton({
  run,
  onDone,
}: {
  run: Run;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<RevertAction[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openDialog = async () => {
    setOpen(true);
    setActions(null);
    setError(null);
    let res: Awaited<ReturnType<typeof revertPreview>>;
    try {
      res = await revertPreview(run.id);
    } catch (err) {
      return setError(failure(err));
    }
    if (!res.ok) {
      return setError(res.message);
    }
    setActions(res.actions);
    setTicked(
      new Set(res.actions.filter(revertsByDefault).map((a) => a.pageId))
    );
  };
  const toggle = (pageId: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (!next.delete(pageId)) {
        next.add(pageId);
      }
      return next;
    });
  const confirm = async () => {
    setBusy(true);
    try {
      const res = await agentRuns().revertRun.mutate({
        runId: run.id,
        include: [...ticked],
      });
      if (!res.ok) {
        return setError(res.message);
      }
      setOpen(false);
      await onDone();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };
  const changes =
    actions?.filter((a) => a.kind !== "skip" && ticked.has(a.pageId)).length ??
    0;
  const live =
    actions?.filter(
      (a) => a.kind === "restore" && a.live && ticked.has(a.pageId)
    ) ?? [];
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void openDialog()}
        data-testid="agent-run-revert"
      >
        <RotateCcw className="h-4 w-4" /> Revert this run
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent
          className="border-border bg-card text-foreground sm:max-w-lg"
          data-testid="agent-revert-confirm"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this run?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Each ticked page goes back to its version from before the run, and
              ticked drafts the run created are archived. Nothing is deleted:
              the current drafts stay in History. Live pages are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!(actions || error) && (
            <p className="text-sm text-muted-foreground">Checking the pages…</p>
          )}
          {!!actions && (
            <ul className="space-y-2 text-sm" data-testid="agent-revert-list">
              {actions.map((a) => (
                <li
                  key={`${a.kind}:${a.pageId}`}
                  data-testid="agent-revert-page"
                  data-kind={a.kind}
                  data-later-edits={
                    a.kind !== "skip" && a.laterEdits ? "true" : undefined
                  }
                >
                  <label
                    className={`flex items-start gap-2 ${a.kind === "skip" ? "" : "cursor-pointer"}`}
                  >
                    {a.kind === "skip" ? (
                      <span className="mt-0.5 inline-block h-4 w-4 shrink-0" />
                    ) : (
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0"
                        checked={ticked.has(a.pageId)}
                        onChange={() => toggle(a.pageId)}
                        data-testid="agent-revert-page-check"
                      />
                    )}
                    <span>
                      <span
                        className={
                          a.kind === "skip" || !ticked.has(a.pageId)
                            ? "text-muted-foreground"
                            : "text-foreground"
                        }
                      >
                        {ACTION_TEXT[a.kind]}
                      </span>{" "}
                      <span className="font-mono">/{a.slug}</span>
                      <span className="text-muted-foreground">
                        {a.kind === "restore"
                          ? " to the version before the run"
                          : a.kind === "archive"
                            ? " (a draft the run created)"
                            : `: ${a.reason}`}
                      </span>
                      {a.kind !== "skip" && a.laterEdits && (
                        <span
                          className="block text-xs text-amber-700 dark:text-amber-300"
                          data-testid="agent-revert-later-edits"
                        >
                          You edited this page after the run — restoring will
                          replace your edits (they stay in History).
                        </span>
                      )}
                      {a.kind === "restore" && a.live && (
                        <span
                          className="block text-xs text-sky-300"
                          data-testid="agent-revert-live"
                        >
                          The run's changes are live on this page. Reverting
                          changes the draft only: republish (or unpublish) it
                          yourself.
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
              {!actions.length && (
                <li className="text-muted-foreground">
                  The run didn't change any page.
                </li>
              )}
            </ul>
          )}
          {live.length > 0 && (
            <p
              className="text-xs text-sky-300"
              data-testid="agent-revert-live-summary"
            >
              Live with the run's changes:{" "}
              {live.map((a) => `/${a.slug}`).join(", ")}. Unpublish/republish
              manually after the revert.
            </p>
          )}
          {!!error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-muted text-foreground hover:bg-accent">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !actions}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
              className="bg-red-700 hover:bg-red-600"
              data-testid="agent-revert-confirm-button"
            >
              {busy
                ? "Reverting…"
                : changes
                  ? `Revert ${changes} page${changes === 1 ? "" : "s"}`
                  : "Mark as reverted"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
