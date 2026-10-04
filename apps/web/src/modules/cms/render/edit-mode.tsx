import type { RichTextDoc } from "@repo/cms-core/richtext/schema";
import type { Device } from "@repo/cms-core/types";
import { createContext, type ReactNode, useContext } from "react";

/** What `RichText` hands the editor for a rich-text field of the selected block. */
export type RichTextSlotArgs = {
  blockKey: string;
  /** Where the field sits in the block's props, with list items addressed by `_key`: `["items", "a1", "body"]`. */
  path: string[];
  doc: RichTextDoc;
  className?: string;
  /** The public renderer's typography (`RichText` variant), for the editor to match. */
  variant?: "default" | "article";
};

/** Set by the editor canvas. The public site never provides it, so `editing` defaults to false. */
export type EditMode = {
  editing: boolean;
  device?: Device;
  /** The editor's selected block; its wrapper renders `data-cms-selected` (outlined by the canvas). */
  selectedKey?: string | null;
  /** The editor's rich-text editor, rendered in place of `RichText` inside the selected block. */
  renderRichText?: (args: RichTextSlotArgs) => ReactNode;
};

export const EditModeContext = createContext<EditMode>({ editing: false });

export function useEditMode(): EditMode {
  return useContext(EditModeContext);
}

/** The `_key` of the block being rendered; provided by BlockWrapper. */
export const BlockKeyContext = createContext<string | null>(null);
