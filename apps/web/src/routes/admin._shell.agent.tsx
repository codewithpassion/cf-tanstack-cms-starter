// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget navigation), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source UI; inline handlers keep it diffable and these admin-only panels are not render-hot.
import { createFileRoute } from "@tanstack/react-router";
import { redirectOnUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import { RunsPage } from "#/modules/cms/agent/ui/runs-page";

/**
 * /admin/agent (docs/cms-plan.md §3.2, §4.4): the AI agent's site-wide runs, each with its review
 * queue (accept or reject per page, created drafts with links) and "Revert this run". `?run=<id>`
 * opens one run.
 */
export const Route = createFileRoute("/admin/_shell/agent")({
  head: () => ({ meta: [{ title: "Agent runs | Admin" }] }),
  validateSearch: (search: Record<string, unknown>): { run?: string } =>
    typeof search.run === "string" && search.run ? { run: search.run } : {},
  // Always fresh: runs move on in the editor.
  gcTime: 0,
  loader: ({ location }) =>
    redirectOnUnauthorized(
      getTrpc().cms.agentRuns.listRuns.query(),
      location.href
    ),
  component: AgentRunsRoute,
});

function AgentRunsRoute() {
  const result = Route.useLoaderData();
  const { run } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!result.ok) {
    return <p className="p-8 text-destructive">{result.message}</p>;
  }
  return (
    <RunsPage
      onSelect={(id) => void navigate({ search: id ? { run: id } : {} })}
      runs={result.runs}
      selected={run ?? null}
      threads={result.threads}
    />
  );
}
