// biome-ignore-all lint/complexity/noForEach: ported verbatim; NodeList/Set iteration as in the source.
// biome-ignore-all lint/complexity/noVoid: `void` marks promises that are deliberately not awaited (fire-and-forget saves and loads), as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/useIterableCallbackReturn: forEach callbacks written as `cond && fn()` expressions, as in the source.
/**
 * Copies the site's stylesheets from the parent document into the canvas iframe's <head> and keeps
 * them in sync, so Vite CSS HMR (which swaps `<link>` elements in the parent, or rewrites a
 * `<style>`'s text) also restyles the canvas. Returns a cleanup function.
 *
 * Allowlist only, so editor and library styles never reach the page:
 * - `<link rel=stylesheet data-cms-canvas>`: the site stylesheet, marked in src/routes/__root.tsx.
 *   It `@import`s the fonts and src/modules/cms/style/cms.css, so one link covers them all.
 *   Vite's HMR swap clones the link, so the mark carries over.
 * - dev only: Vite-injected `<style data-vite-dev-id>` for src/styles.css or
 *   src/modules/cms/**.css. The current setup loads styles.css as a `<link>` (`?url`), so none
 *   exist today; this covers CSS that a block imports directly later.
 *
 * Clones go in the same relative order as in the parent, before `before` (the editor's own styles,
 * which must stay last). A clone whose source is removed stays until every newer `<link>` clone has
 * loaded, so an HMR swap never leaves the canvas unstyled.
 */
const VITE_DEV_ID = /\/src\/(styles|modules\/cms\/.+)\.css$/;

export function mirrorStyles(
  from: Document,
  to: Document,
  before: Element | null
): () => void {
  const win = from.defaultView!;
  const clones = new Map<Element, Element>();
  const pendingLoads = new Set<Promise<void>>();

  const isCanvasSheet = (n: Node): n is HTMLLinkElement | HTMLStyleElement => {
    if (n instanceof win.HTMLLinkElement) {
      return n.rel === "stylesheet" && n.hasAttribute("data-cms-canvas");
    }
    if (n instanceof win.HTMLStyleElement) {
      const id = n.getAttribute("data-vite-dev-id");
      return id !== null && VITE_DEV_ID.test(id.split("?")[0]!);
    }
    return false;
  };

  const add = (src: HTMLLinkElement | HTMLStyleElement) => {
    if (clones.has(src)) {
      return;
    }
    const clone = to.importNode(src, true) as
      | HTMLLinkElement
      | HTMLStyleElement;
    if (src instanceof win.HTMLLinkElement) {
      // An about:blank document inherits the parent's base URL in Chromium; make it explicit anyway.
      clone.setAttribute("href", src.href);
      const loaded = new Promise<void>((resolve) => {
        clone.addEventListener("load", () => resolve(), { once: true });
        clone.addEventListener("error", () => resolve(), { once: true });
      });
      pendingLoads.add(loaded);
      void loaded.then(() => pendingLoads.delete(loaded));
    }
    // Before the clone of the next mirrored sibling in the parent, so order matches.
    let anchor: Element | null = before;
    for (let s = src.nextElementSibling; s; s = s.nextElementSibling) {
      const c = clones.get(s);
      if (c) {
        anchor = c;
        break;
      }
    }
    to.head.insertBefore(
      clone,
      anchor && anchor.parentNode === to.head ? anchor : null
    );
    clones.set(src, clone);
  };

  const remove = (src: Node) => {
    const clone = clones.get(src as Element);
    if (!clone) {
      return;
    }
    clones.delete(src as Element);
    if (pendingLoads.size === 0) {
      clone.remove();
    } else {
      void Promise.all(pendingLoads).then(() => clone.remove());
    }
  };

  from.head
    .querySelectorAll("link[rel=stylesheet], style")
    .forEach((n) => isCanvasSheet(n) && add(n));

  const observer = new win.MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => isCanvasSheet(n) && add(n));
      r.removedNodes.forEach(remove);
      // Text change inside a <style> (Vite's injected CSS modules update this way).
      const style =
        r.target instanceof win.Text ? r.target.parentElement : r.target;
      const clone = style ? clones.get(style as Element) : undefined;
      if (clone && style instanceof win.HTMLStyleElement) {
        clone.textContent = style.textContent;
      }
    }
  });
  observer.observe(from.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return () => {
    observer.disconnect();
    clones.forEach((c) => c.remove());
    clones.clear();
  };
}
