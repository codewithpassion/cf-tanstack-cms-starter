// biome-ignore-all lint/complexity/noVoid: the AI settings card (ported from the source) marks fire-and-forget loads and saves with `void`.
// biome-ignore-all lint/performance/noJsxPropsBind: the AI settings card is ported verbatim from the source; an admin-only form, not render-hot.
// biome-ignore-all lint/style/noNonNullAssertion: the save button only enables once both caps have loaded; `.at(-1)` of a split string always exists.
// biome-ignore-all lint/complexity/useOptionalChain: ported verbatim from the source's AI settings card.
import type { BudgetSettings } from "@repo/cms-core/agent/budget-types";
import {
  type AgentModelOption,
  PROVIDER_LABEL,
  WORKERS_AI_MODEL_ID,
} from "@repo/cms-core/agent/models";
import { GSC_RETENTION_MONTHS } from "@repo/cms-core/gsc/shape";
import type {
  StarterImportItem,
  StarterImportResult,
} from "@repo/services/cms/starter-import";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  goToLogin,
  isUnauthorized,
  redirectOnUnauthorized,
} from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";

/**
 * /admin/setup: one-off steps that fill a new environment from inside its own Worker (no local
 * access to remote D1 or KV needed): import the starter content (published pages, posts and site
 * settings; idempotent). Also the AI agent's settings (stored in D1): default spending limits and
 * the models a new conversation can use.
 */
export const Route = createFileRoute("/admin/_shell/setup")({
  head: () => ({ meta: [{ title: "Setup | Admin" }] }),
  // Always fresh: an import elsewhere changes the counts.
  gcTime: 0,
  loader: async ({ location }) => ({
    status: await redirectOnUnauthorized(
      getTrpc().cms.setup.setupStatus.query(),
      location.href
    ),
  }),
  component: SetupPage,
});

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A failed call's message, or null after sending a signed-out admin to sign in. */
const failureText = (err: unknown): string | null => {
  if (isUnauthorized(err)) {
    goToLogin(window.location.pathname + window.location.search);
    return null;
  }
  return errorText(err);
};

function SetupPage() {
  const { status } = Route.useLoaderData();
  return (
    <div className="max-w-4xl p-8" data-testid="setup-page">
      <h1 className="mb-2 font-bold font-heading text-2xl">Setup</h1>
      <p className="mb-6 text-muted-foreground text-sm">
        One-off steps for a new environment, run by this site's Worker against
        its own database. Each can be run again safely: a second run changes
        nothing.
      </p>
      {status.ok ? (
        <ul
          className="mb-8 flex flex-col gap-1 text-sm"
          data-testid="setup-status"
        >
          <li>
            <span className="text-muted-foreground">Pages:</span> {status.pages}{" "}
            in the CMS, {status.published} published.
          </li>
          <li data-testid="setup-status-gsc">
            <span className="text-muted-foreground">Search Console:</span>{" "}
            {status.gscConfigured ? "connected." : "not connected."}
          </li>
        </ul>
      ) : (
        <p className="mb-8 text-danger">{status.message}</p>
      )}
      <div className="flex flex-col gap-6">
        <StarterImportCard />
        <GscBackfillCard />
        <AiSettingsCard />
      </div>
    </div>
  );
}

type CapField = {
  none: boolean;
  value: string;
};
const capField = (v: number | null): CapField => ({
  value: v === null ? "" : String(v),
  none: v === null,
});

/** AI settings: the agent's default spending limits (raised per conversation or day from the AI tab) and its models. */
function AiSettingsCard() {
  const [thread, setThread] = useState<CapField | null>(null);
  const [daily, setDaily] = useState<CapField | null>(null);
  const [state, setState] = useState<
    { step: "idle" | "saving" | "saved" } | { step: "error"; message: string }
  >({ step: "idle" });

  useEffect(() => {
    void getTrpc()
      .cms.agent.getAgentSettings.query()
      .then(
        (res) => {
          if (!res.ok) {
            return setState({ step: "error", message: res.message });
          }
          setThread(capField(res.settings.threadCapUsd));
          setDaily(capField(res.settings.dailyCapUsd));
        },
        (err: unknown) => {
          const message = failureText(err);
          if (message !== null) {
            setState({ step: "error", message });
          }
        }
      );
  }, []);

  const parse = (f: CapField): number | null | undefined => {
    if (f.none) {
      return null;
    }
    const n = Number(f.value);
    return f.value.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const save = async () => {
    const t = parse(thread!);
    const d = parse(daily!);
    if (t === undefined || d === undefined) {
      return setState({
        step: "error",
        message: "Enter an amount in dollars above 0, or tick “No cap”.",
      });
    }
    setState({ step: "saving" });
    try {
      const settings: BudgetSettings = { threadCapUsd: t, dailyCapUsd: d };
      const res = await getTrpc().cms.agent.saveAgentSettings.mutate(settings);
      setState(
        res.ok ? { step: "saved" } : { step: "error", message: res.message }
      );
    } catch (err) {
      const message = failureText(err);
      if (message !== null) {
        setState({ step: "error", message });
      }
    }
  };

  const field = (
    label: string,
    f: CapField | null,
    set: (f: CapField) => void,
    testId: string
  ) => (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="w-44 text-muted-foreground" htmlFor={testId}>
        {label}
      </label>
      <span className="text-muted-foreground">$</span>
      <input
        className="w-24 rounded border border-border bg-background px-2 py-1 disabled:opacity-50"
        data-testid={testId}
        disabled={!f || f.none}
        id={testId}
        min="0.5"
        onChange={(e) => f && set({ ...f, value: e.target.value })}
        step="0.5"
        type="number"
        value={f ? f.value : ""}
      />
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <input
          checked={f ? f.none : false}
          data-testid={`${testId}-none`}
          disabled={!f}
          onChange={(e) => f && set({ ...f, none: e.target.checked })}
          type="checkbox"
        />
        No cap
      </label>
    </div>
  );

  return (
    <Card
      description="Spending limits for the page agent: when one is reached the agent pauses and the AI tab offers to raise it for that conversation or for the day, so a limit never blocks for good."
      testId="setup-ai-settings"
      title="AI agent settings"
    >
      <div className="flex flex-col gap-3">
        {field("Per conversation", thread, setThread, "ai-thread-cap")}
        {field("Per day (UTC)", daily, setDaily, "ai-daily-cap")}
        <div className="flex items-center gap-3">
          <Button
            data-testid="ai-settings-save"
            disabled={!(thread && daily) || state.step === "saving"}
            onClick={() => void save()}
            size="sm"
          >
            Save
          </Button>
          {state.step === "saved" && (
            <span className="text-emerald-400 text-sm">Saved.</span>
          )}
          {state.step === "error" && (
            <span className="text-danger text-sm">{state.message}</span>
          )}
        </div>
      </div>
      <AgentModelsEditor />
    </Card>
  );
}

/**
 * "Agent models": which models a new AI-tab conversation can pick. Claude is built in; Workers AI
 * text-generation models are added by id and must support function calling. A conversation keeps
 * the model it started with, so changes here only affect new ones.
 */
function AgentModelsEditor() {
  const [models, setModels] = useState<AgentModelOption[] | null>(null);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [state, setState] = useState<
    { step: "idle" | "saving" | "saved" } | { step: "error"; message: string }
  >({ step: "idle" });

  useEffect(() => {
    void getTrpc()
      .cms.agent.getAgentModels.query()
      .then(
        (res) =>
          res.ok
            ? setModels(res.models)
            : setState({ step: "error", message: res.message }),
        (err: unknown) => {
          const message = failureText(err);
          if (message !== null) {
            setState({ step: "error", message });
          }
        }
      );
  }, []);

  const update = (i: number, patch: Partial<AgentModelOption>) => {
    setModels(
      (ms) => ms && ms.map((m, j) => (j === i ? { ...m, ...patch } : m))
    );
    setState({ step: "idle" });
  };
  const add = () => {
    const id = newId.trim();
    if (!WORKERS_AI_MODEL_ID.test(id)) {
      return setState({
        step: "error",
        message: "A Workers AI model id looks like @cf/<org>/<model>.",
      });
    }
    if (models?.some((m) => m.provider === "workers-ai" && m.id === id)) {
      return setState({ step: "error", message: `${id} is already listed.` });
    }
    const label = newLabel.trim() || id.split("/").at(-1)!;
    setModels((ms) => [
      ...(ms ?? []),
      { provider: "workers-ai", id, label, enabled: true, available: true },
    ]);
    setNewId("");
    setNewLabel("");
    setState({ step: "idle" });
  };
  const save = async () => {
    if (!models) {
      return;
    }
    setState({ step: "saving" });
    try {
      const res = await getTrpc().cms.agent.saveAgentModels.mutate({
        models: models.map(({ provider, id, label, enabled }) => ({
          provider,
          id,
          label,
          enabled,
        })),
      });
      if (!res.ok) {
        return setState({ step: "error", message: res.message });
      }
      setModels(res.models);
      setState({ step: "saved" });
    } catch (err) {
      const message = failureText(err);
      if (message !== null) {
        setState({ step: "error", message });
      }
    }
  };

  return (
    <div className="mt-6 border-border border-t pt-4" data-testid="ai-models">
      <h3 className="mb-1 font-semibold">Agent models</h3>
      <p className="mb-3 text-muted-foreground text-sm">
        What a new conversation in the AI tab can use. Each conversation keeps
        the model it started with: turning a model off (or removing it) stops
        its conversations from taking new messages, and they offer to start a
        new thread on another model. Workers AI models are billed to the
        Cloudflare account; prices come from the Workers AI pricing page.
      </p>
      {!models && state.step !== "error" && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
      {!!models && (
        <div className="mb-3 overflow-x-auto">
          <table className="w-full text-sm [overflow-wrap:normal]">
            <thead className="text-left text-muted-foreground text-xs">
              <tr>
                <th className="w-16 py-1 font-normal">Enabled</th>
                <th className="py-1 font-normal">Label</th>
                <th className="py-1 font-normal">Provider</th>
                <th className="py-1 font-normal">Model id</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr
                  className="border-border border-t align-top"
                  data-testid="ai-model-row"
                  key={`${m.provider}|${m.id}`}
                >
                  <td className="py-1.5">
                    <input
                      aria-label={`Enable ${m.label}`}
                      checked={m.enabled}
                      data-testid="ai-model-enabled"
                      onChange={(e) => update(i, { enabled: e.target.checked })}
                      type="checkbox"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      aria-label="Label"
                      className="w-full rounded border border-border bg-background px-2 py-0.5"
                      maxLength={60}
                      onChange={(e) => update(i, { label: e.target.value })}
                      value={m.label}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">
                    {PROVIDER_LABEL[m.provider]}
                  </td>
                  <td className="py-1.5 pr-2">
                    <code className="text-muted-foreground text-xs">
                      {m.id}
                    </code>
                    {!m.available && !!m.reason && (
                      <p className="mt-0.5 text-amber-300/90 text-xs">
                        Unavailable here: {m.reason}
                      </p>
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    {m.provider === "workers-ai" && (
                      <button
                        className="text-muted-foreground text-xs hover:text-danger"
                        data-testid="ai-model-remove"
                        onClick={() =>
                          setModels((ms) => ms && ms.filter((_, j) => j !== i))
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <input
          aria-label="Workers AI model id"
          className="w-72 rounded border border-border bg-background px-2 py-1"
          data-testid="ai-model-new-id"
          onChange={(e) => setNewId(e.target.value)}
          placeholder="@cf/<org>/<model>"
          value={newId}
        />
        <input
          aria-label="Label for the new model"
          className="w-40 rounded border border-border bg-background px-2 py-1"
          maxLength={60}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label"
          value={newLabel}
        />
        <Button
          data-testid="ai-model-add"
          disabled={!newId.trim()}
          onClick={add}
          size="sm"
          variant="secondary"
        >
          Add Workers AI model
        </Button>
      </div>
      <p className="mb-3 text-muted-foreground text-xs">
        Function calling required: only add text-generation models whose Workers
        AI page lists function calling. The agent can't work without tools.
      </p>
      <div className="flex items-center gap-3">
        <Button
          data-testid="ai-models-save"
          disabled={!models || state.step === "saving"}
          onClick={() => void save()}
          size="sm"
        >
          Save models
        </Button>
        {state.step === "saved" && (
          <span className="text-emerald-400 text-sm">Saved.</span>
        )}
        {state.step === "error" && (
          <span className="text-danger text-sm">{state.message}</span>
        )}
      </div>
    </div>
  );
}

type BackfillWindow = { start: string; end: string };
type BackfillState =
  | { step: "loading" }
  | { step: "unconfigured" }
  | { step: "idle" }
  | { step: "running"; done: number; rows: number }
  | { step: "done"; rows: number }
  | { step: "error"; message: string };

/** "Backfill Search Console history": pulls the last 16 months one month at a time, so no request does it all. Only offered once Search Console is connected. */
function GscBackfillCard() {
  const [windows, setWindows] = useState<BackfillWindow[]>([]);
  const [state, setState] = useState<BackfillState>({ step: "loading" });

  useEffect(() => {
    void getTrpc()
      .cms.setup.planGscBackfill.query({ months: GSC_RETENTION_MONTHS })
      .then(
        (plan) => {
          if (!plan.ok) {
            return setState({ step: "error", message: plan.message });
          }
          setWindows(plan.windows);
          setState({ step: plan.configured ? "idle" : "unconfigured" });
        },
        (err: unknown) => {
          const message = failureText(err);
          if (message !== null) {
            setState({ step: "error", message });
          }
        }
      );
  }, []);

  const run = async () => {
    let rows = 0;
    try {
      for (const [done, window] of windows.entries()) {
        setState({ step: "running", done, rows });
        const res =
          // biome-ignore lint/performance/noAwaitInLoops: one month per request, in order, so no single request does the whole backfill.
          await getTrpc().cms.setup.runGscBackfillMonth.mutate(window);
        if (!res.ok) {
          return setState({ step: "error", message: res.message });
        }
        rows += res.summary.rows;
      }
      setState({ step: "done", rows });
    } catch (err) {
      const message = failureText(err);
      if (message !== null) {
        setState({ step: "error", message });
      }
    }
  };

  const canRun =
    windows.length > 0 &&
    (state.step === "idle" || state.step === "done" || state.step === "error");

  return (
    <Card
      description={`Pulls up to ${GSC_RETENTION_MONTHS} months of Search Console history into the database, one month at a time. The daily sync keeps it current afterwards. Safe to run again: each month's rows are replaced.`}
      testId="gsc-backfill"
      title="Backfill Search Console history"
    >
      {state.step === "loading" && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
      {state.step === "unconfigured" && (
        <p className="text-muted-foreground text-sm">
          Search Console isn't connected yet. Connect it first (see the go-live
          guide), then come back here.
        </p>
      )}
      {state.step === "running" && (
        <p className="text-sm" data-testid="gsc-backfill-progress">
          Month {state.done + 1} of {windows.length}… {state.rows} rows so far.
        </p>
      )}
      {state.step === "done" && (
        <p className="mb-3 text-sm" data-testid="gsc-backfill-done">
          Pulled {windows.length} months, {state.rows} rows.
        </p>
      )}
      {state.step === "error" && (
        <p className="mb-3 text-danger text-sm">{state.message}</p>
      )}
      {canRun ? (
        <Button data-testid="gsc-backfill-run" onClick={run} size="sm">
          {state.step === "idle" ? "Backfill history" : "Run again"}
        </Button>
      ) : null}
    </Card>
  );
}

function Card({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section
      className="rounded border border-border bg-card p-5"
      data-testid={testId}
    >
      <h2 className="mb-1 font-semibold text-lg">{title}</h2>
      <p className="mb-4 text-muted-foreground text-sm">{description}</p>
      {children}
    </section>
  );
}

type ImportState =
  | { step: "idle" }
  | { step: "busy" }
  | { step: "done"; result: StarterImportResult }
  | { step: "error"; message: string };

/** One button: creates and publishes the starter content, then lists what happened. */
function StarterImportCard() {
  const [state, setState] = useState<ImportState>({ step: "idle" });

  const run = useCallback(async () => {
    setState({ step: "busy" });
    try {
      const res = await getTrpc().cms.setup.importStarterContent.mutate();
      setState(
        res.ok
          ? { step: "done", result: res }
          : { step: "error", message: res.message }
      );
    } catch (err) {
      const message = failureText(err);
      if (message !== null) {
        setState({ step: "error", message });
      }
    }
  }, []);

  return (
    <Card
      description="Creates and publishes a home page, About, Pricing, Contact and three blog posts with placeholder text and images, plus the site menu and footer. Pages that already exist are skipped and edited site settings are left alone, so it is safe to run again."
      testId="import-starter"
      title="Import starter content"
    >
      {state.step === "done" && <ImportTable result={state.result} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="import-starter-run"
          disabled={state.step === "busy"}
          onClick={run}
          size="sm"
        >
          {state.step === "busy" ? "Importing…" : "Import starter content"}
        </Button>
        {state.step === "error" && (
          <span className="text-danger text-sm">{state.message}</span>
        )}
      </div>
    </Card>
  );
}

function ImportTable({ result }: { result: StarterImportResult }) {
  const actionText = (item: StarterImportItem): string =>
    item.action === "create"
      ? "Created and published"
      : "Already exists, skipped";
  return (
    <>
      <div className="mb-4 overflow-x-auto">
        <table
          className="w-full text-sm [overflow-wrap:normal]"
          data-testid="import-table"
        >
          <thead className="text-left text-muted-foreground text-xs">
            <tr>
              <th className="py-1 font-normal">Page</th>
              <th className="py-1 font-normal">Path</th>
              <th className="py-1 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr className="border-border border-t" key={item.path}>
                <td className="py-1.5 pr-3">
                  <Link
                    className="text-primary hover:underline"
                    params={{ pageId: item.pageId }}
                    to="/admin/editor/$pageId"
                  >
                    {item.title}
                  </Link>
                </td>
                <td className="py-1.5 pr-3">
                  <code className="text-xs">{item.path}</code>
                </td>
                <td className="py-1.5">{actionText(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mb-4 text-muted-foreground text-sm">
        Site menu and footer:{" "}
        {result.site === "created"
          ? "created and published."
          : "left as they are (already edited)."}
      </p>
    </>
  );
}
