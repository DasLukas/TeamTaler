import Bus from 'lucide-react/dist/esm/icons/bus';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import Coins from 'lucide-react/dist/esm/icons/coins';
import Gavel from 'lucide-react/dist/esm/icons/gavel';
import GlassWater from 'lucide-react/dist/esm/icons/glass-water';
import Shapes from 'lucide-react/dist/esm/icons/shapes';
import Trophy from 'lucide-react/dist/esm/icons/trophy';
import Utensils from 'lucide-react/dist/esm/icons/utensils';
import type { ComponentType, SVGProps } from 'react';
import type { CategoryIcon as CategoryIconName } from '@/api/types';

const CATEGORY_ICON_COMPONENTS: Record<CategoryIconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  other: Shapes,
  drink: GlassWater,
  food: Utensils,
  penalty: Gavel,
  sport: Trophy,
  event: CalendarDays,
  transport: Bus,
  money: Coins,
};

/** Properties accepted by the shared category icon renderer. */
export interface CategoryIconProps {
  icon: CategoryIconName;
  size?: number;
  strokeWidth?: number;
}

/**
 * Renders the Lucide glyph mapped to a persisted category icon value.
 *
 * @param props - Persisted icon name and optional SVG sizing configuration.
 * @returns A decorative SVG carrying its stable category-icon identifier.
 */
export function CategoryIcon({ icon, size = 24, strokeWidth = 1.8 }: CategoryIconProps) {
  const Icon = CATEGORY_ICON_COMPONENTS[icon];
  return <Icon aria-hidden="true" data-category-icon={icon} height={size} strokeWidth={strokeWidth} width={size} />;
}
