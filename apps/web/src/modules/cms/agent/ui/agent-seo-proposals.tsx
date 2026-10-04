// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget loads and saves), as in the source.
// biome-ignore-all lint/correctness/useImageSize: media-library images and screenshots of unknown size, sized by their CSS classes.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source UI; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/suspicious/noArrayIndexKey: lists rebuilt per render from fixed arrays with no ids (variants, warnings, errors), never reordered.
import type { Changeset } from "@repo/cms-core/agent/types";
import { mediaUrl } from "@repo/cms-core/media";
import { Bot, Check, X } from "lucide-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "#/components/ui/button";
import { type AgentView, AgentViewContext } from "./agent-view";

/**
 * The agent's pending SEO proposals at the top of the SEO tab (docs/cms-plan.md §4.4): pick one of
 * the 2–3 title/description variants and apply it with the keyphrase, social copy, share image,
 * page type and llms.txt summary in one step (one undo step, one `agent` revision), or reject it.
 * Renders nothing outside the editor's agent context or when nothing is pending.
 */
export function AgentSeoProposals() {
  const view = useContext(AgentViewContext);
  if (!view) {
    return null;
  }
  return <Proposals view={view} />;
}

function Proposals({ view }: { view: AgentView }) {
  const state = useSyncExternalStore(
    view.subscribe,
    view.getState,
    view.getState
  );
  // SEO proposals that site-wide runs made for this page are picked here too.
  useEffect(() => {
    void view.loadSiteProposals();
  }, [view]);
  const own = state.scope === "page" ? state.changesets : [];
  const pending = [...own, ...state.siteProposals].filter(
    (c) => c.kind === "seo" && c.status === "pending" && c.seo
  );
  if (!pending.length) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="agent-seo-proposals">
      {pending.map((cs) => (
        <Proposal
          key={cs.id}
          cs={cs}
          view={view}
          busy={state.deciding === cs.id}
        />
      ))}
    </div>
  );
}

function Proposal({
  cs,
  view,
  busy,
}: {
  cs: Changeset;
  view: AgentView;
  busy: boolean;
}) {
  const [variant, setVariant] = useState(0);
  const seo = cs.seo!;
  const p = seo.seo;
  return (
    <div
      className="rounded border border-violet-700/60 bg-violet-950/30 p-3 text-sm"
      data-testid="agent-seo-proposal"
    >
      <p className="mb-2 flex items-center gap-2 font-medium">
        <Bot className="h-4 w-4" /> Agent proposal
      </p>
      {!!p.focusKeyphrase && (
        <p className="text-xs">
          <span className="text-neutral-400">Focus keyphrase:</span>{" "}
          <strong data-testid="agent-seo-keyphrase">{p.focusKeyphrase}</strong>
        </p>
      )}
      {!!seo.rationale && (
        <p className="mt-1 text-xs text-neutral-400">{seo.rationale}</p>
      )}
      <fieldset className="mt-2 space-y-1.5">
        <legend className="mb-1 text-xs text-neutral-400">
          Pick a title and description
        </legend>
        {seo.variants.map((v, i) => (
          <label
            key={i}
            className={`block cursor-pointer rounded border p-2 ${variant === i ? "border-violet-500 bg-violet-900/30" : "border-neutral-700"}`}
            data-testid="agent-seo-variant"
          >
            <input
              type="radio"
              name={`variant-${cs.id}`}
              className="mr-2"
              checked={variant === i}
              onChange={() => setVariant(i)}
            />
            <span className="font-medium text-sky-300">{v.title}</span>
            <span className="mt-0.5 block text-xs text-neutral-300">
              {v.description}
            </span>
            <span className="mt-0.5 block text-[10px] text-neutral-500">
              {v.title.length} / {v.description.length} characters
              {v.note ? ` · ${v.note}` : ""}
            </span>
          </label>
        ))}
      </fieldset>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        {!!p.social?.title && (
          <>
            <dt className="text-neutral-400">Social title</dt>
            <dd>{p.social.title}</dd>
          </>
        )}
        {!!p.social?.description && (
          <>
            <dt className="text-neutral-400">Social text</dt>
            <dd>{p.social.description}</dd>
          </>
        )}
        {!!p.schema?.pageType && (
          <>
            <dt className="text-neutral-400">Page type</dt>
            <dd>{p.schema.pageType}</dd>
          </>
        )}
        {(p.llms?.summary || p.llms?.include !== undefined) && (
          <>
            <dt className="text-neutral-400">llms.txt</dt>
            <dd>
              {p.llms.include === false && (
                <strong className="text-amber-300">Not listed. </strong>
              )}
              {p.llms.include === true && <strong>Listed. </strong>}
              {p.llms.summary}
            </dd>
          </>
        )}
      </dl>
      {!!p.social?.image && (
        <img
          src={mediaUrl(p.social.image.mediaId)}
          alt={p.social.image.alt}
          className="mt-2 w-full rounded border border-neutral-700"
          data-testid="agent-seo-image"
        />
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={() => void view.applySeo(cs.id, variant)}
          disabled={busy}
          data-testid="agent-seo-apply"
        >
          <Check className="h-3.5 w-3.5" /> Apply option {variant + 1}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.reject(cs.id)}
          disabled={busy}
          data-testid="agent-seo-reject"
        >
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
      </div>
    </div>
  );
}
