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
