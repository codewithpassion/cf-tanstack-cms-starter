import { formatDateTime } from "@repo/cms-core/format-date";
import {
  API_SCOPES,
  type ApiScope,
  SCOPE_HELP,
} from "@repo/cms-core/mcp/scopes";
import type { ConnectionInfo } from "@repo/services/mcp/connections";
import type { ApiKeyInfo, McpCall } from "@repo/services/mcp/keys";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import {
  type ChangeEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
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
import { Button } from "#/components/ui/button";
import {
  goToLogin,
  isUnauthorized,
  redirectOnUnauthorized,
} from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";

/**
 * /admin/api-keys: keys for the CMS MCP server at `/mcp`.
 * Create a key with a name and a scope (the key is shown once, with its `claude mcp add` command),
 * list and revoke keys, and see a key's last 50 tool calls. Keys are stored hashed in D1.
 * "Connected apps" lists the OAuth clients (Claude.ai, Claude Desktop, …) an admin approved on
 * /oauth/authorize, with Revoke and the same call log.
 */
export const Route = createFileRoute("/admin/_shell/api-keys")({
  component: ApiKeysPage,
  gcTime: 0,
  head: () => ({ meta: [{ title: "API keys | Admin" }] }),
  loader: ({ location }) =>
    redirectOnUnauthorized(
      getTrpc().cms.apiKeys.listApiKeys.query(),
      location.href
    ),
});

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const when = (iso: string | null) => (iso ? formatDateTime(iso) : "—");

type CallerKind = "api-key" | "oauth";
/** What the revoke dialog confirms: a key or a connected app. */
type RevokeTarget = {
  id: string;
  kind: CallerKind;
  name: string;
};

function ApiKeysPage() {
  const { keys, connections, mcpUrl } = Route.useLoaderData();
  const [open, setOpen] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<RevokeTarget | null>(null);
  const closeRevoke = useCallback(() => setRevoking(null), []);
  return (
    <div className="max-w-5xl p-4 md:p-8" data-testid="api-keys-page">
      <h1 className="mb-2 font-bold font-heading text-2xl">API keys</h1>
      <p className="mb-6 text-neutral-400 text-sm">
        Keys for the CMS MCP server at{" "}
        <code className="text-neutral-200">{mcpUrl}</code>, for Claude Code and
        other MCP clients. A key can do everything its scope allows, on every
        page. Changes it makes are recorded as{" "}
        <code className="text-neutral-200">
          mcp:&lt;key name&gt;#&lt;key prefix&gt;
        </code>
        .
      </p>
      <CreateKey />
      <div className="relative mt-8 overflow-x-auto">
        <table
          className="w-full text-left text-sm [overflow-wrap:normal]"
          data-testid="api-keys-table"
        >
          <thead className="text-neutral-400">
            <tr className="border-neutral-800 border-b">
              <th className="py-2 pr-3 font-normal">Name</th>
              <th className="py-2 pr-3 font-normal">Scope</th>
              <th className="py-2 pr-3 font-normal">Prefix</th>
              <th className="py-2 pr-3 font-normal">Created</th>
              <th className="py-2 pr-3 font-normal">Last used</th>
              <th className="py-2 pr-3 font-normal">Status</th>
              <th className="py-2 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td className="py-4 text-neutral-500" colSpan={7}>
                  No keys yet.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <KeyRow
                k={k}
                key={k.id}
                onRevoke={setRevoking}
                onToggle={setOpen}
                open={open === k.id}
              />
            ))}
          </tbody>
        </table>
      </div>
      <ConnectedApps
        connections={connections}
        mcpUrl={mcpUrl}
        onRevoke={setRevoking}
        onToggle={setOpen}
        open={open}
      />
      <RevokeDialog onClose={closeRevoke} target={revoking} />
    </div>
  );
}

function ConnectedApps({
  connections,
  mcpUrl,
  open,
  onToggle,
  onRevoke,
}: {
  connections: ConnectionInfo[];
  mcpUrl: string;
  open: string | null;
  onToggle: (id: string | null) => void;
  onRevoke: (target: RevokeTarget) => void;
}) {
  return (
    <section className="mt-12" data-testid="connected-apps">
      <h2 className="mb-2 font-bold font-heading text-xl">Connected apps</h2>
      <p className="mb-4 text-neutral-400 text-sm">
        Apps that signed in with OAuth, such as Claude.ai and Claude Desktop:
        add <code className="text-neutral-200">{mcpUrl}</code> as a custom
        connector, sign in with this admin login and approve. Changes they make
        are recorded as{" "}
        <code className="text-neutral-200">mcp:&lt;app name (date)&gt;</code>.
      </p>
      <div className="relative overflow-x-auto">
        <table
          className="w-full text-left text-sm [overflow-wrap:normal]"
          data-testid="connections-table"
        >
          <thead className="text-neutral-400">
            <tr className="border-neutral-800 border-b">
              <th className="py-2 pr-3 font-normal">App</th>
              <th className="py-2 pr-3 font-normal">Scope</th>
              <th className="py-2 pr-3 font-normal">Approved by</th>
              <th className="py-2 pr-3 font-normal">Created</th>
              <th className="py-2 pr-3 font-normal">Last used</th>
              <th className="py-2 pr-3 font-normal">Status</th>
              <th className="py-2 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connections.length === 0 && (
              <tr>
                <td className="py-4 text-neutral-500" colSpan={7}>
                  No connected apps yet.
                </td>
              </tr>
            )}
            {connections.map((c) => (
              <ConnectionRow
                c={c}
                key={c.id}
                onRevoke={onRevoke}
                onToggle={onToggle}
                open={open === c.id}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Where a connection's tokens go, as a host; the stored value when it isn't a URL. */
function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

function ConnectionRow({
  c,
  open,
  onToggle,
  onRevoke,
}: {
  c: ConnectionInfo;
  open: boolean;
  onToggle: (id: string | null) => void;
  onRevoke: (target: RevokeTarget) => void;
}) {
  const toggle = useCallback(
    () => onToggle(open ? null : c.id),
    [c.id, onToggle, open]
  );
  const revoke = useCallback(
    () => onRevoke({ id: c.id, name: c.name, kind: "oauth" }),
    [c.id, c.name, onRevoke]
  );
  return (
    <>
      <tr className="border-neutral-900 border-b" data-testid="connection-row">
        <td className="py-2 pr-3">
          {c.name}
          <div className="text-neutral-500 text-xs">
            → {redirectHost(c.redirectUri)}
          </div>
        </td>
        <td className="py-2 pr-3">{c.scope}</td>
        <td className="py-2 pr-3 text-neutral-400">{c.email}</td>
        <td className="py-2 pr-3 text-neutral-400">{when(c.createdAt)}</td>
        <td className="py-2 pr-3 text-neutral-400">{when(c.lastUsedAt)}</td>
        <td className="py-2 pr-3">
          {c.revokedAt ? (
            <span className="text-neutral-500">
              Revoked {when(c.revokedAt)}
            </span>
          ) : (
            <span className="text-emerald-300">Active</span>
          )}
        </td>
        <td className="space-x-3 whitespace-nowrap py-2 text-right">
          <button
            className="text-neutral-400 hover:text-white"
            data-testid="connection-calls-toggle"
            onClick={toggle}
            type="button"
          >
            {open ? "Hide calls" : "Calls"}
          </button>
          {!c.revokedAt && (
            <button
              className="text-danger hover:underline"
              data-testid="connection-revoke"
              onClick={revoke}
              type="button"
            >
              Revoke
            </button>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td className="pb-4" colSpan={7}>
            <KeyCalls id={c.id} kind="oauth" />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CreateKey() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>("write");
  const [state, setState] = useState<
    | { step: "idle" | "saving" }
    | { step: "error"; message: string }
    | { step: "created"; key: string; command: string }
  >({ step: "idle" });

  const onName = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const onScope = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => setScope(e.target.value as ApiScope),
    []
  );
  const create = useCallback(async () => {
    setState({ step: "saving" });
    try {
      const res = await getTrpc().cms.apiKeys.createApiKey.mutate({
        name,
        scope,
      });
      setState({ command: res.command, key: res.key, step: "created" });
      setName("");
      await router.invalidate();
    } catch (err) {
      if (isUnauthorized(err)) {
        goToLogin(window.location.pathname + window.location.search);
        return;
      }
      setState({ message: errorText(err), step: "error" });
    }
  }, [name, router, scope]);

  return (
    <section
      className="rounded border border-neutral-800 bg-neutral-900 p-4"
      data-testid="api-key-create"
    >
      <h2 className="mb-3 font-semibold">New key</h2>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Name</span>
          <input
            className="w-64 max-w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
            data-testid="api-key-name"
            maxLength={60}
            onChange={onName}
            placeholder="e.g. My laptop"
            value={name}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Scope</span>
          <select
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
            data-testid="api-key-scope"
            onChange={onScope}
            value={scope}
          >
            {API_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <Button
          data-testid="api-key-create-button"
          disabled={!name.trim() || state.step === "saving"}
          onClick={create}
          size="sm"
        >
          {state.step === "saving" ? "Creating…" : "Create key"}
        </Button>
      </div>
      <p className="mt-2 text-neutral-500 text-xs">{SCOPE_HELP[scope]}</p>
      {state.step === "error" && (
        <p className="mt-3 text-danger text-sm">{state.message}</p>
      )}
      {state.step === "created" && (
        <div
          className="mt-4 space-y-2 rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm"
          data-testid="api-key-created"
        >
          <p className="text-emerald-200">
            Copy the key now: it isn't shown again.
          </p>
          <CopyLine testId="api-key-value" text={state.key} />
          <p className="pt-1 text-neutral-300">Connect Claude Code:</p>
          <CopyLine testId="api-key-command" text={state.command} />
        </div>
      )}
    </section>
  );
}

function CopyLine({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    // No Clipboard API outside a secure context (the plain-HTTP dev origin): copy it by hand.
    if (!navigator.clipboard) {
      toast.error("Copying isn't available here; select the text instead.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error(`Not copied: ${errorText(err)}`);
    }
  }, [text]);
  return (
    <div className="flex items-center gap-2">
      <code
        className="min-w-0 flex-1 select-all break-all rounded bg-neutral-950 px-2 py-1 text-neutral-200 text-xs"
        data-testid={testId}
      >
        {text}
      </code>
      <button
        aria-label="Copy"
        className="text-neutral-400 hover:text-white"
        data-testid={`${testId}-copy`}
        onClick={copy}
        type="button"
      >
        {copied ? (
          <Check className="h-4 w-4 text-emerald-300" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

function KeyStatus({ k }: { k: ApiKeyInfo }) {
  if (k.revokedAt) {
    return (
      <span className="text-neutral-500">Revoked {when(k.revokedAt)}</span>
    );
  }
  return <span className="text-emerald-300">Active</span>;
}

function KeyRow({
  k,
  open,
  onToggle,
  onRevoke,
}: {
  k: ApiKeyInfo;
  open: boolean;
  onToggle: (id: string | null) => void;
  onRevoke: (target: RevokeTarget) => void;
}) {
  const toggle = useCallback(
    () => onToggle(open ? null : k.id),
    [k.id, onToggle, open]
  );
  const revoke = useCallback(
    () => onRevoke({ id: k.id, name: k.name, kind: "api-key" }),
    [k.id, k.name, onRevoke]
  );
  return (
    <>
      <tr className="border-neutral-900 border-b" data-testid="api-key-row">
        <td className="py-2 pr-3">{k.name}</td>
        <td className="py-2 pr-3">{k.scope}</td>
        <td className="py-2 pr-3">
          <code className="text-neutral-300 text-xs">{k.prefix}…</code>
        </td>
        <td className="py-2 pr-3 text-neutral-400">{when(k.createdAt)}</td>
        <td className="py-2 pr-3 text-neutral-400">{when(k.lastUsedAt)}</td>
        <td className="py-2 pr-3">
          <KeyStatus k={k} />
        </td>
        <td className="space-x-3 whitespace-nowrap py-2 text-right">
          <button
            className="text-neutral-400 hover:text-white"
            data-testid="api-key-calls-toggle"
            onClick={toggle}
            type="button"
          >
            {open ? "Hide calls" : "Calls"}
          </button>
          {!k.revokedAt && (
            <button
              className="text-danger hover:underline"
              data-testid="api-key-revoke"
              onClick={revoke}
              type="button"
            >
              Revoke
            </button>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td className="pb-4" colSpan={7}>
            <KeyCalls id={k.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Confirms, then revokes a key or a connected app: it gets 401 from the next request. */
function RevokeDialog({
  target,
  onClose,
}: {
  target: RevokeTarget | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = useCallback(async () => {
    if (!target) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { apiKeys } = getTrpc().cms;
      const revokeFn =
        target.kind === "oauth"
          ? apiKeys.revokeConnection
          : apiKeys.revokeApiKey;
      await revokeFn.mutate({ id: target.id });
      toast(`Revoked "${target.name}"`);
      onClose();
      await router.invalidate();
    } catch (err) {
      if (isUnauthorized(err)) {
        goToLogin(window.location.pathname + window.location.search);
        return;
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [onClose, router, target]);

  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen || busy) {
        return;
      }
      setError(null);
      onClose();
    },
    [busy, onClose]
  );
  // The action closes the dialog by default; keep it open until the call returns.
  const onConfirm = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      return revoke();
    },
    [revoke]
  );

  return (
    <AlertDialog onOpenChange={onOpenChange} open={target !== null}>
      <AlertDialogContent
        className="border-neutral-700 bg-neutral-900 text-neutral-100 sm:max-w-md"
        data-testid="api-key-revoke-confirm"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke "{target?.name}"?</AlertDialogTitle>
          <AlertDialogDescription className="text-neutral-400">
            {target?.kind === "oauth"
              ? "The app stops working at once. To use it again, connect it again from the app."
              : "Clients using it stop working at once. Revoked keys can't be turned back on; create a new key instead."}
          </AlertDialogDescription>
          {error ? <p className="text-danger text-sm">{error}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="border-neutral-700 bg-transparent"
            disabled={busy}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-revoke"
            disabled={busy}
            onClick={onConfirm}
            variant="destructive"
          >
            {busy ? "Revoking…" : "Revoke"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function KeyCalls({ id, kind = "api-key" }: { id: string; kind?: CallerKind }) {
  const [calls, setCalls] = useState<McpCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTrpc()
      .cms.apiKeys.apiKeyCalls.query({ id, kind })
      .then(
        (res) => !cancelled && setCalls(res.calls),
        (err: unknown) => {
          if (isUnauthorized(err)) {
            goToLogin(window.location.pathname + window.location.search);
            return;
          }
          return !cancelled && setError(errorText(err));
        }
      );
    return () => {
      cancelled = true;
    };
  }, [id, kind]);
  if (error) {
    return <p className="text-danger text-sm">{error}</p>;
  }
  if (!calls) {
    return <p className="text-neutral-500 text-sm">Loading…</p>;
  }
  if (!calls.length) {
    return <p className="text-neutral-500 text-sm">No calls yet.</p>;
  }
  return (
    <table
      className="w-full text-xs [overflow-wrap:normal]"
      data-testid="api-key-calls"
    >
      <tbody>
        {calls.map((c) => (
          <tr className="border-neutral-900 border-b" key={c.id}>
            <td className="py-1 pr-3 text-neutral-400">{when(c.at)}</td>
            <td className="py-1 pr-3 font-mono">{c.tool}</td>
            <td className="py-1 pr-3 text-neutral-300">{c.target ?? ""}</td>
            <td className="py-1">
              {c.ok ? (
                <span className="text-emerald-300">ok</span>
              ) : (
                <span className="text-danger">{c.errorCode ?? "error"}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
