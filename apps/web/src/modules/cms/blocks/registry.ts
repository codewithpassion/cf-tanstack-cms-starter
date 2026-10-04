import type { BlockIconName } from "@repo/cms-core/blocks/icon-names";
import { type postList, selectPosts } from "@repo/cms-core/blocks/post-list";
import {
  type AnyBlockDef,
  BLOCK_DEFS,
  BLOCK_TYPES,
  type BlockType,
  isBlockType,
} from "@repo/cms-core/blocks/registry";
import {
  BadgeCheck,
  BadgeDollarSign,
  ChartColumn,
  Check,
  CircleHelp,
  Image as ImageIcon,
  LayoutGrid,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  MessageSquareQuote,
  MousePointerClick,
  Newspaper,
  PanelTop,
  Quote,
  Type,
} from "lucide-react";
import type { ComponentType } from "react";
import type { z } from "zod";

import type { CmsRenderData } from "../render/render-context";
import { CalloutBlock } from "./callout";
import { ChecklistBlock } from "./checklist";
import { CtaBlock } from "./cta";
import { FaqBlock } from "./faq";
import { FeatureGridBlock } from "./feature-grid";
import { HeroBlock } from "./hero";
import { ImageBlock } from "./image";
import { LogosBlock } from "./logos";
import { PostListBlock } from "./post-list";
import { PricingBlock } from "./pricing";
import { RichTextBlock } from "./rich-text";
import { StatsBlock } from "./stats";
import { StepsBlock } from "./steps";
import { TestimonialBlock } from "./testimonial";
import type { BlockComponentProps } from "./ui";

/**
 * The web half of each block: cms-core holds the pure def (schema, defaults, guidance; its `icon`
 * is a lucide name), this file pairs it with the React `Component`, the lucide `Icon` and an
 * optional `hiddenWhen`. Validation stays in cms-core (`parseBlock`, `validatePageDoc`); look up
 * what renders a validated block here.
 */

/** Block icons by the lucide name a def gives. `satisfies` keeps the map and cms-core's list in step. */
export const BLOCK_ICONS = {
  "badge-check": BadgeCheck,
  "badge-dollar-sign": BadgeDollarSign,
  "chart-column": ChartColumn,
  check: Check,
  "circle-help": CircleHelp,
  image: ImageIcon,
  "layout-grid": LayoutGrid,
  "list-ordered": ListOrdered,
  "list-todo": ListTodo,
  "message-square-quote": MessageSquareQuote,
  "mouse-pointer-click": MousePointerClick,
  newspaper: Newspaper,
  "panel-top": PanelTop,
  quote: Quote,
  type: Type,
} satisfies Record<BlockIconName, LucideIcon>;

// `any` props: each Component is typed to its own def's schema output, which TS can't widen to unknown.
// biome-ignore lint/suspicious/noExplicitAny: as cms-core's AnyBlockDef.
type AnyProps = any;

export type BlockUi = {
  Component: ComponentType<BlockComponentProps<AnyProps>>;
  /**
   * On the public site, render nothing at all (not even the block's section and its spacing) when
   * this returns true, e.g. a post list with no posts to show. The editor always renders the block.
   */
  hiddenWhen?: (props: AnyProps, render: CmsRenderData) => boolean;
};

/** A cms-core def with its web half. */
export type WebBlockDef = AnyBlockDef & BlockUi & { Icon: LucideIcon };

type PostListProps = z.output<typeof postList.schema>;

/** Every BlockType must have a Component, or this fails to compile. */
const UI: { [K in BlockType]: BlockUi } = {
  hero: { Component: HeroBlock },
  richText: { Component: RichTextBlock },
  featureGrid: { Component: FeatureGridBlock },
  steps: { Component: StepsBlock },
  pricing: { Component: PricingBlock },
  faq: { Component: FaqBlock },
  cta: { Component: CtaBlock },
  image: { Component: ImageBlock },
  logos: { Component: LogosBlock },
  testimonial: { Component: TestimonialBlock },
  stats: { Component: StatsBlock },
  callout: { Component: CalloutBlock },
  postList: {
    Component: PostListBlock,
    // No posts to show: nothing on the public site (the editor shows a placeholder instead).
    hiddenWhen: (props: PostListProps, render) =>
      selectPosts(render.posts ?? [], props).length === 0,
  },
  checklist: { Component: ChecklistBlock },
};

const BLOCKS = Object.fromEntries(
  BLOCK_TYPES.map((type) => {
    const def: AnyBlockDef = BLOCK_DEFS[type];
    const block: WebBlockDef = {
      ...def,
      ...UI[type],
      Icon: BLOCK_ICONS[def.icon],
    };
    return [type, block];
  })
) as { [K in BlockType]: WebBlockDef };

/** The def plus Component, Icon and hiddenWhen of `type`; undefined for an unknown or retired type. */
export function getBlock(type: string): WebBlockDef | undefined {
  return isBlockType(type) ? BLOCKS[type] : undefined;
}

/** Every block type, in `BLOCK_TYPES` order (the editor's insert menu order). */
export function listBlocks(): WebBlockDef[] {
  return BLOCK_TYPES.map((type) => BLOCKS[type]);
}
