/**
 * Icon keys a document may name (feature-grid and logos items). The web app maps each key to a
 * lucide component (`apps/web/src/modules/cms/blocks/icons.ts`); keep the two lists in step.
 */
export const ICON_NAMES = [
  "bot",
  "brain",
  "building",
  "chart",
  "check",
  "clock",
  "code",
  "cog",
  "graduation-cap",
  "lightbulb",
  "message",
  "rocket",
  "settings",
  "shield",
  "sparkles",
  "target",
  "trending-up",
  "users",
  "workflow",
  "zap",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Lucide icon names (kebab-case) the block defs use for their own `icon`; the web registry maps each to a component. */
export const BLOCK_ICON_NAMES = [
  "badge-check",
  "badge-dollar-sign",
  "chart-column",
  "check",
  "circle-help",
  "image",
  "layout-grid",
  "list-ordered",
  "list-todo",
  "message-square-quote",
  "mouse-pointer-click",
  "newspaper",
  "panel-top",
  "quote",
  "type",
] as const;

export type BlockIconName = (typeof BLOCK_ICON_NAMES)[number];
