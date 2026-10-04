import type { ShareParams } from "@repo/cms-core/share/params";
import type { PageDoc, PageKind } from "@repo/cms-core/types";

// TODO(cms-port-ui): placeholder so the share-image route builds. The UI phase replaces it with
// the real 1200x630 card (title, wordmark, background and template variants from `params`).
export function OgCard({
  doc,
  params,
}: {
  doc: PageDoc;
  kind: PageKind;
  params: ShareParams;
}) {
  return (
    <div
      data-template={params.template}
      style={{ width: 1200, height: 630, padding: 64, background: "#fff" }}
    >
      <h1 style={{ fontSize: 72 }}>{doc.seo.title}</h1>
    </div>
  );
}
