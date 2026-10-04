// biome-ignore-all lint/suspicious/noUnnecessaryConditions: the renderer also gets unvalidated documents, whose nodes may be null or malformed.
// biome-ignore-all lint/suspicious/noArrayIndexKey: rich-text nodes carry no ids, and a rendered document's children never reorder.

import type {
  ListItem,
  Paragraph,
  RichTextDoc,
  RichTextNode,
  RichTextText,
} from "@repo/cms-core/richtext/schema";
import { isSafeHref } from "@repo/cms-core/safe-href";
import { Fragment, type ReactNode, useContext } from "react";

import { BlockKeyContext, useEditMode } from "../render/edit-mode";

/**
 * JSON → React walker for the restricted rich-text schema. Text is always rendered as React
 * children (escaped); unknown nodes and marks render nothing; links are re-checked here so an
 * unvalidated document still can't produce a `javascript:` href.
 */

const linkClass =
  "text-[color:var(--cms-accent,var(--color-accent))] underline underline-offset-4 hover:opacity-80 transition-opacity";

function renderText(node: RichTextText, key: number): ReactNode {
  let out: ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        out = <strong className="font-bold">{out}</strong>;
        break;
      case "italic":
        out = <em>{out}</em>;
        break;
      case "code":
        out = (
          <code className="font-mono text-[0.9em] bg-ink-soft px-1.5 py-0.5 rounded">
            {out}
          </code>
        );
        break;
      case "link":
        if (isSafeHref(mark.attrs.href)) {
          out = (
            <a href={mark.attrs.href} className={linkClass}>
              {out}
            </a>
          );
        }
        break;
      default:
        break;
    }
  }
  return <span key={key}>{out}</span>;
}

function renderInline(content: RichTextText[] | undefined): ReactNode {
  return content?.map((node, i) =>
    node?.type === "text" && typeof node.text === "string"
      ? renderText(node, i)
      : null
  );
}

/** `check`: bullet lists render as ✓ rows; the ✓ is real text. */
export type Bullets = "disc" | "check";

const checkClass =
  "text-[color:var(--cms-accent,var(--color-accent))] font-heading font-bold text-xs mt-1 shrink-0";

function renderListItem(
  item: ListItem,
  key: number,
  bullets: Bullets,
  check = false
): ReactNode {
  if (item?.type !== "listItem") {
    return null;
  }
  const children = item.content.map((child, i) =>
    renderNode(child, i, true, bullets)
  );
  if (!check) {
    return <li key={key}>{children}</li>;
  }
  return (
    <li key={key} className="flex items-start gap-3">
      <span className={checkClass} aria-hidden="true">
        &#x2713;
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function renderNode(
  node: RichTextNode | Paragraph,
  key: number,
  inList = false,
  bullets: Bullets = "disc"
): ReactNode {
  switch (node?.type) {
    case "paragraph":
      return (
        <p
          key={key}
          className={inList ? undefined : "mb-4 last:mb-0 leading-relaxed"}
        >
          {renderInline(node.content)}
        </p>
      );
    case "heading": {
      const Tag = node.attrs?.level === 3 ? "h3" : "h2";
      const size =
        Tag === "h2" ? "text-2xl md:text-3xl" : "text-xl md:text-2xl";
      return (
        <Tag
          key={key}
          className={`font-heading font-bold ${size} text-[color:var(--cms-heading,var(--color-white))] mt-8 mb-4 first:mt-0`}
        >
          {renderInline(node.content)}
        </Tag>
      );
    }
    case "bulletList":
      return bullets === "check" ? (
        <ul key={key} className="mb-4 last:mb-0 space-y-2">
          {node.content.map((item, i) =>
            renderListItem(item, i, bullets, true)
          )}
        </ul>
      ) : (
        <ul key={key} className="list-disc pl-6 mb-4 last:mb-0 space-y-2">
          {node.content.map((item, i) => renderListItem(item, i, bullets))}
        </ul>
      );
    case "orderedList":
      return (
        <ol
          key={key}
          start={node.attrs?.start}
          className="list-decimal pl-6 mb-4 last:mb-0 space-y-2"
        >
          {node.content.map((item, i) => renderListItem(item, i, bullets))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-l-4 border-primary pl-6 my-6 italic"
        >
          {node.content.map((child, i) => renderNode(child, i, false, bullets))}
        </blockquote>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Article typography: a blog post's body (the richText block inside the post layout), with the
// blog's article look (docs/cms-plan.md §3.8). Colours read
// the block's --cms-* vars with that look as the fallback.

const articleText = "text-[color:var(--cms-text,rgb(255_255_255/0.8))]";
const articleAccent = "text-[color:var(--cms-accent,var(--color-accent))]";
const ARTICLE = {
  p: `${articleText} font-sans text-lg leading-relaxed mb-6`,
  h2: "font-heading font-bold text-2xl md:text-3xl text-[color:var(--cms-heading,var(--color-primary))] mt-12 mb-6",
  h3: `font-heading font-bold text-xl ${articleAccent} mt-8 mb-4`,
  ul: "space-y-3 mb-6",
  li: `flex gap-3 ${articleText} font-sans leading-relaxed`,
  ol: `list-decimal pl-6 space-y-3 mb-6 ${articleText} font-sans leading-relaxed`,
  blockquote:
    "cyber-border bg-ink-soft/30 pl-6 py-4 my-8 border-l-4 border-primary",
  quoteP: "text-white font-sans text-xl italic leading-relaxed not-first:mt-4",
};

/** A list item's content: its paragraphs' text inline (as the blog's `<span>{item}</span>`), nested lists as lists. */
function articleItemContent(item: ListItem): ReactNode {
  return item.content.map((child, i) =>
    child?.type === "paragraph" ? (
      <Fragment key={i}>
        {i > 0 && " "}
        {renderInline(child.content)}
      </Fragment>
    ) : (
      renderArticleNode(child, i)
    )
  );
}

function renderArticleNode(
  node: RichTextNode | Paragraph,
  key: number,
  inQuote = false
): ReactNode {
  switch (node?.type) {
    case "paragraph":
      return (
        <p key={key} className={inQuote ? ARTICLE.quoteP : ARTICLE.p}>
          {renderInline(node.content)}
        </p>
      );
    case "heading": {
      const Tag = node.attrs?.level === 3 ? "h3" : "h2";
      return (
        <Tag key={key} className={Tag === "h2" ? ARTICLE.h2 : ARTICLE.h3}>
          {renderInline(node.content)}
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul key={key} className={ARTICLE.ul}>
          {node.content.map((item, i) =>
            item?.type === "listItem" ? (
              <li key={i} className={ARTICLE.li}>
                <span className={`${articleAccent} mt-1`}>&#9658;</span>
                <span>{articleItemContent(item)}</span>
              </li>
            ) : null
          )}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} start={node.attrs?.start} className={ARTICLE.ol}>
          {node.content.map((item, i) =>
            item?.type === "listItem" ? (
              <li key={i}>{articleItemContent(item)}</li>
            ) : null
          )}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote key={key} className={ARTICLE.blockquote}>
          {node.content.map((child, i) => renderArticleNode(child, i, true))}
        </blockquote>
      );
    default:
      return null;
  }
}

/**
 * `path`: where this document sits in the block's props (list items by `_key`, e.g.
 * `["items", item._key, "body"]`). With it, the editor swaps in its rich-text editor while the
 * block is selected.
 */
export function RichText({
  doc,
  className,
  path,
  bullets = "disc",
  variant = "default",
}: {
  doc: RichTextDoc;
  className?: string;
  path?: string[];
  bullets?: Bullets;
  /** `article`: a blog post's body typography (see ARTICLE). */
  variant?: "default" | "article";
}) {
  const { editing, selectedKey, renderRichText } = useEditMode();
  const blockKey = useContext(BlockKeyContext);
  if (
    editing &&
    path &&
    renderRichText &&
    blockKey !== null &&
    blockKey === selectedKey
  ) {
    return renderRichText({ blockKey, path, doc, className, variant });
  }
  if (variant === "article") {
    return (
      <div className={className}>
        {doc?.content?.map((node, i) => renderArticleNode(node, i))}
      </div>
    );
  }
  return (
    <div className={className}>
      {doc?.content?.map((node, i) => renderNode(node, i, false, bullets))}
    </div>
  );
}
