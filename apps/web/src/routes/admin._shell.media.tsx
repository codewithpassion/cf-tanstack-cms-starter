// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source admin; inline handlers keep it diffable and this admin-only page is not render-hot.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; the "Used on" states are kept as in the source.
import { createFileRoute, Link } from "@tanstack/react-router";
import type { inferRouterOutputs } from "@trpc/server";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { goToLogin, isUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";
import {
  MediaBrowser,
  type MediaInfo,
} from "#/modules/cms/editor/media-library";
import { useSiteConfig } from "#/modules/cms/site/site-context";
import type { AppRouter } from "#/server/trpc/router";

/** Where an image is used (`cms.media.getMediaUsage`); the row type lives server-side in `@repo/db`. */
type MediaUsage =
  inferRouterOutputs<AppRouter>["cms"]["media"]["getMediaUsage"];

/**
 * /admin/media: the media library as a page. Browse, search, upload (drop files anywhere on the
 * grid), edit alt text and tags, copy an image's URL and see where it's used. No delete: media is
 * never deleted in v1 (docs/cms-plan.md §3.2), since page history and agent conversations point at it.
 */
export const Route = createFileRoute("/admin/_shell/media")({
  head: () => ({ meta: [{ title: "Media | Admin" }] }),
  component: MediaPage,
});

function MediaPage() {
  return (
    <div className="p-8 text-neutral-100">
      <div className="mb-6">
        <h1 className="font-bold font-heading text-2xl">Media</h1>
        <p className="mt-1 text-neutral-400 text-sm">
          Every image in the library. Drop files on the grid to upload (JPEG,
          PNG, WebP, GIF, AVIF; up to 10 MB).
        </p>
      </div>
      <MediaBrowser
        active
        details={renderDetails}
        gridClassName="h-[45vh] md:h-[calc(100vh-16rem)] md:min-h-80"
      />
    </div>
  );
}

const renderDetails = (m: MediaInfo) => <MediaDetails key={m.id} media={m} />;

function MediaDetails({ media }: { media: MediaInfo }) {
  const config = useSiteConfig();
  const [usage, setUsage] = useState<MediaUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const url = new URL(
    media.url,
    typeof window === "undefined" ? config.origin : window.location.origin
  ).toString();

  useEffect(() => {
    let cancelled = false;
    getTrpc()
      .cms.media.getMediaUsage.query({ id: media.id })
      .then((u) => {
        if (!cancelled) {
          setUsage(u);
        }
      })
      .catch((e: unknown) => {
        if (isUnauthorized(e)) {
          goToLogin(window.location.pathname + window.location.search);
          return;
        }
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [media.id]);

  const copy = async () => {
    // `navigator.clipboard` is only there in a secure context (not the plain-HTTP dev origin).
    if (!navigator.clipboard) {
      setCopyError("Copying needs HTTPS: select the URL and copy it.");
      return;
    }
    await navigator.clipboard.writeText(url);
    setCopyError(null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="mt-4 space-y-3 border-neutral-800 border-t pt-3 text-xs"
      data-testid="media-details"
    >
      <div className="space-y-1">
        <div className="text-neutral-400">URL</div>
        <div className="flex items-center gap-2">
          <code
            className="min-w-0 flex-1 select-all truncate rounded bg-neutral-950 px-2 py-1 text-neutral-300"
            title={url}
          >
            {url}
          </code>
          <button
            aria-label="Copy URL"
            className="text-neutral-400 hover:text-white"
            data-testid="media-copy-url"
            onClick={() => {
              copy().catch(() => setCopyError("Could not copy the URL."));
            }}
            type="button"
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-300" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
        {!!copyError && <p className="text-red-400">{copyError}</p>}
      </div>
      <div className="space-y-1">
        <div className="text-neutral-400">Used on</div>
        {error ? (
          <p className="text-red-400">{error}</p>
        ) : usage ? (
          usage.pages.length === 0 && !usage.site ? (
            <p className="text-neutral-500">Not used on any page.</p>
          ) : (
            <ul className="space-y-1" data-testid="media-usage">
              {!!usage.site && (
                <li>
                  <Link
                    className="text-white hover:text-accent"
                    to="/admin/site"
                  >
                    Site settings
                  </Link>
                </li>
              )}
              {usage.pages.map((p) => (
                <li key={p.id}>
                  <Link
                    className="text-white hover:text-accent"
                    params={{ pageId: p.id }}
                    to="/admin/editor/$pageId"
                  >
                    {p.title}
                  </Link>
                  <span className="ml-1 text-neutral-500">
                    /{p.slug} ·{" "}
                    {p.inLive
                      ? p.inDraft
                        ? "live and draft"
                        : "live only"
                      : "draft only"}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-neutral-500">Checking…</p>
        )}
      </div>
    </div>
  );
}
