// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: the toolbar only cancels mousedown so the editor keeps its selection; its buttons are the interactive elements.
// biome-ignore-all lint/a11y/noStaticElementInteractions: the toolbar only cancels mousedown so the editor keeps its selection; its buttons are the interactive elements.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.

import { LINK_HINT, linkAction } from "@repo/cms-core/editor/link-input";
import { sanitizeRichText } from "@repo/cms-core/editor/richtext-json";
import { deepEqual } from "@repo/cms-core/ops/json";
import {
  type RichTextDoc,
  richTextSchema,
} from "@repo/cms-core/richtext/schema";
import { isSafeHref } from "@repo/cms-core/safe-href";
import { Editor } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import type { Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";

/**
 * TipTap editor for one rich-text field, restricted to the CMS schema (@repo/cms-core/richtext/schema).
 * Works in the canvas iframe and in the inspector: the ProseMirror view is mounted straight onto a
 * node in whichever document renders this component (`element: { mount }`), so its selection and
 * DOM observers bind to that document. No EditorContent, and no TipTap undo history: undo is the
 * editor store's.
 *
 * Changes are sanitised, validated and emitted 400ms after typing stops (the store coalesces them
 * into one undo step); `registerFlusher` lets the store force a pending emit before undo or save.
 */

/** Same classes as the public renderer (modules/cms/richtext/render.tsx), so nothing shifts when the editor mounts. */
const CLASSES = {
  paragraph: "mb-4 last:mb-0 leading-relaxed",
  heading:
    "font-heading font-semibold tracking-tight text-[color:var(--cms-heading,var(--foreground))] mt-8 mb-4 first:mt-0 [&:is(h2)]:text-2xl md:[&:is(h2)]:text-3xl [&:is(h3)]:text-xl md:[&:is(h3)]:text-2xl",
  bulletList: "list-disc pl-6 mb-4 last:mb-0 space-y-2",
  orderedList: "list-decimal pl-6 mb-4 last:mb-0 space-y-2",
  blockquote: "border-l-4 border-primary pl-6 my-6 italic",
  code: "font-mono text-[0.9em] bg-muted px-1.5 py-0.5 rounded",
  bold: "font-bold",
  link: "text-[color:var(--cms-accent,var(--primary))] underline underline-offset-4",
  // The list item's paragraphs carry no margin in the public renderer.
  root: "outline-none [&_li>p]:mb-0",
};

/** The inspector's copy of the field: same structure, compact type. */
const COMPACT: typeof CLASSES = {
  paragraph: "mb-2 last:mb-0",
  heading:
    "font-bold mt-3 mb-1 first:mt-0 [&:is(h2)]:text-base [&:is(h3)]:text-sm",
  bulletList: "list-disc pl-5 mb-2 last:mb-0",
  orderedList: "list-decimal pl-5 mb-2 last:mb-0",
  blockquote: "border-l-2 border-primary pl-3 my-2 italic",
  code: CLASSES.code,
  bold: CLASSES.bold,
  link: "text-primary underline",
  root: CLASSES.root,
};

/**
 * A blog post's body on the canvas: close to the article typography of the public renderer
 * (render.tsx ARTICLE). Bullets are the list's ► markers rather than the public site's ► text.
 */
const ARTICLE: typeof CLASSES = {
  paragraph:
    "text-[color:var(--cms-text,var(--muted-foreground))] font-sans text-lg leading-relaxed mb-6",
  heading:
    "font-heading font-semibold tracking-tight [&:is(h2)]:text-2xl md:[&:is(h2)]:text-3xl [&:is(h2)]:text-[color:var(--cms-heading,var(--foreground))] [&:is(h2)]:mt-12 [&:is(h2)]:mb-6 [&:is(h3)]:text-xl [&:is(h3)]:text-[color:var(--cms-accent,var(--primary))] [&:is(h3)]:mt-8 [&:is(h3)]:mb-4",
  bulletList:
    "list-disc marker:text-primary pl-7 space-y-3 mb-6 text-foreground/80 font-sans leading-relaxed [&_p]:text-base",
  orderedList:
    "list-decimal pl-6 space-y-3 mb-6 text-foreground/80 font-sans leading-relaxed [&_p]:text-base",
  blockquote:
    "bg-muted/50 pl-6 py-4 my-8 border-l-4 border-primary [&_p]:text-foreground [&_p]:text-xl [&_p]:italic [&_p]:mb-0",
  code: CLASSES.code,
  bold: CLASSES.bold,
  link: CLASSES.link,
  root: CLASSES.root,
};

export const EMIT_DEBOUNCE_MS = 400;

const NOTICE_EVERY_MS = 5000;
const noticeShownAt = new Map<string, number>();

/**
 * A destructive toast, at most once per message every 5s: rich text re-validates on every pause in
 * typing, so the same problem would otherwise toast again and again.
 */
export function richTextNotice(message: string) {
  const now = Date.now();
  if (
    now - (noticeShownAt.get(message) ?? Number.NEGATIVE_INFINITY) <
    NOTICE_EVERY_MS
  ) {
    return;
  }
  noticeShownAt.set(message, now);
  toast.error(message);
}

const HTTP_LINK_NOTICE =
  "Only https links are allowed: the http link was removed";
/** An `<a href="http:…">` in pasted HTML; the Link extension drops it (isAllowedUri). */
const PASTED_HTTP_LINK = /<a\b[^>]*\bhref\s*=\s*["']?\s*http:/i;

function extensions(c: typeof CLASSES) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3], HTMLAttributes: { class: c.heading } },
      paragraph: { HTMLAttributes: { class: c.paragraph } },
      bulletList: { HTMLAttributes: { class: c.bulletList } },
      orderedList: { HTMLAttributes: { class: c.orderedList } },
      blockquote: { HTMLAttributes: { class: c.blockquote } },
      code: { HTMLAttributes: { class: c.code } },
      bold: { HTMLAttributes: { class: c.bold } },
      undoRedo: false,
      link: false,
      underline: false,
      strike: false,
      codeBlock: false,
      hardBreak: false,
      horizontalRule: false,
      // It appends an empty paragraph after a final heading or list, which would be saved.
      trailingNode: false,
      dropcursor: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      HTMLAttributes: { class: c.link, target: null, rel: null },
      isAllowedUri: (url) => isSafeHref(url),
    }),
  ];
}

type RichTextEditorProps = {
  value: RichTextDoc;
  /** A sanitised, valid document that differs from `value`. */
  onChange: (doc: RichTextDoc) => void;
  /** Called with a message when the content can't be saved (e.g. an unsafe link), or null when it can again. */
  onInvalid?: (message: string | null) => void;
  registerFlusher?: (flush: () => void) => () => void;
  className?: string;
  /**
   * "bubble": a floating toolbar over the selection, and the public site's type (canvas).
   * "static": a toolbar above the field, and compact type (inspector).
   */
  toolbar: "bubble" | "static";
  /** `article`: a blog post's body typography on the canvas (bubble toolbar only). */
  variant?: "default" | "article";
  autoFocus?: boolean;
  /** False: shown, not editable (an archived page). */
  editable?: boolean;
  "data-testid"?: string;
};

export function RichTextEditor({
  value,
  onChange,
  onInvalid,
  registerFlusher,
  className,
  toolbar,
  variant = "default",
  autoFocus,
  editable = true,
  "data-testid": testId,
}: RichTextEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, rerender] = useState(0);
  const latest = useRef({ value, onChange, onInvalid });
  latest.current = { value, onChange, onInvalid };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The link being edited: the selection it applies to and the link there now ("" for none).
  const [linkEdit, setLinkEdit] = useState<LinkEdit | null>(null);
  const editLink = (ed: Editor) => {
    const { from, to } = ed.state.selection;
    const href = (ed.getAttributes("link").href as string | undefined) ?? "";
    setLinkEdit({ from, to, href });
  };

  // Create once per mount node; the document it lives in decides where ProseMirror listens.
  useLayoutEffect(() => {
    const mount = mountRef.current!;
    const ed = new Editor({
      element: { mount },
      extensions: extensions(
        toolbar === "static"
          ? COMPACT
          : variant === "article"
            ? ARTICLE
            : CLASSES
      ),
      content: latest.current.value,
      injectCSS: false,
      editable,
      autofocus: autoFocus ? "end" : false,
      editorProps: {
        attributes: {
          class: CLASSES.root,
          style: "white-space: pre-wrap; word-wrap: break-word;",
        },
        // Pasted http links are dropped (links are https, relative, mailto: or tel: only); say so.
        transformPastedHTML(html) {
          if (PASTED_HTTP_LINK.test(html)) {
            richTextNotice(HTTP_LINK_NOTICE);
          }
          return html;
        },
        // A plain http URL pasted over a selection would have become a link.
        transformPastedText(text, _plain, view) {
          if (
            !view.state.selection.empty &&
            /^\s*http:\/\/\S+\s*$/i.test(text)
          ) {
            richTextNotice(HTTP_LINK_NOTICE);
          }
          return text;
        },
      },
    });
    setEditor(ed);
    return () => {
      if (timer.current) {
        emit(ed);
      }
      ed.destroy();
      setEditor(null);
    };
  }, []);

  function emit(ed: Editor) {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = null;
    if (ed.isDestroyed) {
      return;
    }
    const doc = sanitizeRichText(ed.getJSON());
    const parsed = richTextSchema.safeParse(doc);
    if (!parsed.success) {
      latest.current.onInvalid?.(
        parsed.error.issues[0]?.message ?? "This text can't be saved"
      );
      return;
    }
    latest.current.onInvalid?.(null);
    if (!deepEqual(doc, latest.current.value)) {
      latest.current.onChange(doc);
    }
  }

  useEffect(() => {
    if (!editor) {
      return;
    }
    const onUpdate = () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => emit(editor), EMIT_DEBOUNCE_MS);
    };
    const onUi = () => rerender((n) => n + 1);
    // Leaving the field commits a pending edit now rather than after the debounce.
    const onBlur = () => {
      if (timer.current) {
        emit(editor);
      }
      onUi();
    };
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onUi);
    editor.on("transaction", onUi);
    editor.on("focus", onUi);
    editor.on("blur", onBlur);
    const unregister = registerFlusher?.(() => {
      if (timer.current) {
        emit(editor);
      }
    });
    return () => {
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onUi);
      editor.off("transaction", onUi);
      editor.off("focus", onUi);
      editor.off("blur", onBlur);
      unregister?.();
    };
  }, [editor, registerFlusher]);

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) {
      editor.setEditable(editable, false);
    }
  }, [editor, editable]);

  // External changes (undo, the other editor for this field): replace the content, unless the
  // user has an edit waiting to be emitted (it would be lost; the flusher runs before undo anyway).
  useEffect(() => {
    if (!editor || editor.isDestroyed || timer.current) {
      return;
    }
    if (deepEqual(sanitizeRichText(editor.getJSON()), value)) {
      return;
    }
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  return (
    <div className={className} data-cms-interactive="" data-testid={testId}>
      {editor && editable && toolbar === "static" && (
        <Toolbar editor={editor} onLink={() => editLink(editor)} />
      )}
      <div ref={mountRef} />
      {editor && toolbar === "bubble" && (
        <BubbleToolbar
          editor={editor}
          mount={mountRef.current}
          onLink={() => editLink(editor)}
        />
      )}
      {!!editor && !!linkEdit && (
        <LinkDialog
          editor={editor}
          edit={linkEdit}
          onClose={() => setLinkEdit(null)}
        />
      )}
    </div>
  );
}

/** The floating toolbar, portalled into the editor's own document so it sits in the canvas when the editor does. */
function BubbleToolbar({
  editor,
  mount,
  onLink,
}: {
  editor: Editor;
  mount: HTMLElement | null;
  onLink: () => void;
}) {
  const doc = mount?.ownerDocument;
  const win = doc?.defaultView;
  const { from, to, empty } = editor.state.selection;
  if (!(doc && win) || empty || !editor.isFocused) {
    return null;
  }
  let top: number;
  let left: number;
  try {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    top = Math.min(start.top, end.top) + win.scrollY - 44;
    left = Math.max(4, (start.left + end.left) / 2 + win.scrollX - 150);
  } catch {
    return null;
  }
  // In the scaled canvas frame, counter-scale so the buttons stay a usable size.
  const frameWidth =
    win.frameElement?.getBoundingClientRect().width ?? win.innerWidth;
  const zoom = Math.min(
    2.5,
    Math.max(1, win.innerWidth / Math.max(1, frameWidth))
  );
  return createPortal(
    <div
      data-cms-ui=""
      style={{
        position: "absolute",
        top,
        left,
        zIndex: 70,
        transform: `scale(${zoom})`,
        transformOrigin: "bottom left",
      }}
    >
      <Toolbar editor={editor} onLink={onLink} />
    </div>,
    doc.body
  );
}

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const chain = () => editor.chain().focus();
  return (
    <div
      className="flex items-center gap-0.5 rounded border border-border bg-card p-1 text-foreground shadow-lg"
      // Keep the editor's selection: buttons act on mousedown's default being suppressed.
      onMouseDown={(e) => e.preventDefault()}
      data-testid="rich-text-toolbar"
    >
      <ToolButton
        label="Bold"
        active={editor.isActive("bold")}
        onClick={() => chain().toggleBold().run()}
      >
        <Bold className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Code"
        active={editor.isActive("code")}
        onClick={() => chain().toggleCode().run()}
      >
        <Code className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Link"
        active={editor.isActive("link")}
        onClick={onLink}
      >
        <Link2 className="h-4 w-4" />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-accent" />
      <ToolButton
        label="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Heading 3"
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Bullet list"
        active={editor.isActive("bulletList")}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => chain().toggleBlockquote().run()}
      >
        <Quote className="h-4 w-4" />
      </ToolButton>
    </div>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded p-1.5 ${active ? "bg-accent text-black" : "hover:bg-accent"}`}
    >
      {children}
    </button>
  );
}

type LinkEdit = { from: number; to: number; href: string };

/**
 * Edits the link on the selection. The source used `prompt()`/`alert()`; native dialogs block the
 * page, so this is a Radix dialog in the parent document (modal Radix stays out of the canvas
 * iframe). Same rules and messages (link-input.ts): empty removes the link, unsafe hrefs are
 * refused inline. Esc or Cancel closes without changes; focus returns to the text either way.
 *
 * The selection is captured on open. If the document changes while the dialog is open (undo, or
 * the field's other editor replacing the content), those positions would point at other text, so
 * the dialog closes instead of applying the link there.
 */
function LinkDialog({
  editor,
  edit,
  onClose,
}: {
  editor: Editor;
  edit: LinkEdit;
  onClose: () => void;
}) {
  const id = useId();
  const [href, setHref] = useState(edit.href);
  const [error, setError] = useState<string | null>(null);
  const range = { from: edit.from, to: edit.to };
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        toast("The text changed, so the link wasn't applied.");
        closeRef.current();
      }
    };
    const onDestroy = () => closeRef.current();
    editor.on("transaction", onTransaction);
    editor.on("destroy", onDestroy);
    const off = () => {
      editor.off("transaction", onTransaction);
      editor.off("destroy", onDestroy);
    };
    detachRef.current = off;
    return off;
  }, [editor]);
  const detach = () => detachRef.current?.();
  const onRange = () =>
    editor.chain().focus().setTextSelection(range).extendMarkRange("link");

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const action = linkAction(href);
    if (action.kind === "invalid") {
      setError(action.message);
      return;
    }
    // Stop watching for document changes before making this one.
    detach();
    if (!editor.isDestroyed) {
      if (action.kind === "remove") {
        onRange().unsetLink().run();
      } else {
        onRange().setLink({ href: action.href }).run();
      }
    }
    onClose();
  };
  const remove = () => {
    detach();
    if (!editor.isDestroyed) {
      onRange().unsetLink().run();
    }
    onClose();
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="max-w-md border-border sm:max-w-md bg-card text-foreground"
        data-testid="link-dialog"
        // Back to the text, not to the toolbar button (it unmounts when the editor loses focus).
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!editor.isDestroyed) {
            editor.chain().focus().setTextSelection(range).run();
          }
        }}
        // Clicks here bubble through the React tree into the canvas blocks; keep them here.
        onClick={(e) => e.stopPropagation()}
      >
        <form className="space-y-4" onSubmit={apply}>
          <DialogHeader>
            <DialogTitle>{edit.href ? "Edit link" : "Add link"}</DialogTitle>
            <DialogDescription id={`${id}-hint`}>{LINK_HINT}</DialogDescription>
          </DialogHeader>
          <Input
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            aria-invalid={!!error}
            aria-label="Link"
            autoFocus
            className="border-border bg-background"
            data-testid="link-input"
            onChange={(e) => {
              setHref(e.target.value);
              setError(null);
            }}
            placeholder="/path or https://"
            value={href}
          />
          {!!error && (
            <p
              className="text-destructive text-sm"
              data-testid="link-error"
              id={`${id}-error`}
              role="alert"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            {!!edit.href && (
              <Button
                data-testid="link-remove"
                onClick={remove}
                type="button"
                variant="ghost"
              >
                Remove link
              </Button>
            )}
            <Button
              data-testid="link-cancel"
              onClick={onClose}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button data-testid="link-apply" type="submit">
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
