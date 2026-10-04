import { createContext, useContext, useSyncExternalStore } from "react";

import type { EditorSnapshot, EditorStore } from "./store";

export const EditorStoreContext = createContext<EditorStore | null>(null);

export function useEditorStore(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store) {
    throw new Error("useEditorStore must be used inside the page editor");
  }
  return store;
}

/** The store's current snapshot; re-renders on every change. */
export function useEditorState(): EditorSnapshot {
  const store = useEditorStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}
