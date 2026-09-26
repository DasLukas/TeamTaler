import ShoppingCart from 'lucide-react/dist/esm/icons/shopping-cart';
import Boxes from 'lucide-react/dist/esm/icons/boxes';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import ChartNoAxesCombined from 'lucide-react/dist/esm/icons/chart-no-axes-combined';
import ArrowLeftRight from 'lucide-react/dist/esm/icons/arrow-left-right';
import Home from 'lucide-react/dist/esm/icons/home';
import Settings from 'lucide-react/dist/esm/icons/settings';
import { FinanceNavigationIcon } from './FinanceNavigationIcon';
import { memberPaths } from '@/app/paths';

/** Capability discriminator used to filter shared module destinations. */
export type NavigationCapability = 'book' | 'planning' | 'statistics' | 'catalog' | 'finance' | 'administration' | null;

/**
 * Ordered application modules shared by desktop, tablet, and mobile navigation.
 *
 * Mobile surfaces split this sequence between the bottom bar and the More page
 * without changing the relative order of the destinations.
 */
export const moduleNavigationItems = [
  { to: memberPaths.overview, key: 'overview', icon: Home, capability: null },
  { to: memberPaths.booking, key: 'book', icon: ShoppingCart, capability: 'book' },
  { to: memberPaths.activities, key: 'activities', icon: ArrowLeftRight, capability: null },
  { to: memberPaths.planning, key: 'planning', icon: CalendarDays, capability: 'planning' },
  { to: memberPaths.statistics, key: 'statistics', icon: ChartNoAxesCombined, capability: 'statistics' },
  { to: memberPaths.catalog, key: 'catalog', icon: Boxes, capability: 'catalog' },
  { to: memberPaths.finance, key: 'finance', icon: FinanceNavigationIcon, capability: 'finance' },
  { to: '/admin', key: 'administration', icon: Settings, capability: 'administration' },
] as const;

/** Module keys rendered directly in the mobile bottom navigation. */
export const mobilePrimaryModuleKeys: ReadonlySet<string> = new Set(['overview', 'book', 'activities']);
