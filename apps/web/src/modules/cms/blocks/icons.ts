import type { IconName } from "@repo/cms-core/blocks/icon-names";
import {
  Bot,
  Brain,
  Building,
  ChartColumn,
  Check,
  Clock,
  Code,
  Cog,
  GraduationCap,
  Lightbulb,
  type LucideIcon,
  MessageSquare,
  Rocket,
  Settings,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

/**
 * The item icons a document may name (cms-core `ICON_NAMES`), so documents can name an icon
 * without bundling the whole lucide library. `satisfies` keeps this map and the cms-core list in step.
 */
export const ICONS = {
  bot: Bot,
  brain: Brain,
  building: Building,
  chart: ChartColumn,
  check: Check,
  clock: Clock,
  code: Code,
  cog: Cog,
  "graduation-cap": GraduationCap,
  lightbulb: Lightbulb,
  message: MessageSquare,
  rocket: Rocket,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  target: Target,
  "trending-up": TrendingUp,
  users: Users,
  workflow: Workflow,
  zap: Zap,
} satisfies Record<IconName, LucideIcon>;
