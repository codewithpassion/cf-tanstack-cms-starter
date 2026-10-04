import { isSafeHref } from "../safe-href";

/**
 * The rich-text link editor's rules (rich-text-editor.tsx). The source asked with `prompt()` and
 * refused with `alert()`; native dialogs block the page (and browser automation), so the editor uses
 * an in-app dialog with these same rules and messages.
 */
export const LINK_HINT =
  "Link (/path, #id, https://, mailto: or tel:). Empty removes the link.";

export const UNSAFE_LINK_MESSAGE =
  "Links must be relative (/path, #id) or use https:, mailto: or tel:";

export type LinkAction =
  | { kind: "remove" }
  | { kind: "set"; href: string }
  | { kind: "invalid"; message: string };

/** What applying `input` does: empty removes the link, a safe href sets it, anything else is refused. */
export function linkAction(input: string): LinkAction {
  const href = input.trim();
  if (href === "") {
    return { kind: "remove" };
  }
  if (!isSafeHref(href)) {
    return { kind: "invalid", message: UNSAFE_LINK_MESSAGE };
  }
  return { kind: "set", href };
}
