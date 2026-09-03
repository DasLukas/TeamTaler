import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import Boxes from 'lucide-react/dist/esm/icons/boxes';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import Home from 'lucide-react/dist/esm/icons/home';
import Settings from 'lucide-react/dist/esm/icons/settings';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { memberPaths } from '@/app/paths';

/** Capability discriminator used to filter shared module destinations. */
export type NavigationCapability = 'book' | 'planning' | 'catalog' | 'finance' | 'administration' | null;

/**
 * Ordered application modules shared by desktop, tablet, and mobile navigation.
 *
 * Mobile surfaces split this sequence between the bottom bar and the More page
 * without changing the relative order of the destinations.
 */
export const moduleNavigationItems = [
  { to: memberPaths.overview, key: 'overview', icon: Home, capability: null },
  { to: memberPaths.booking, key: 'book', icon: BookOpenCheck, capability: 'book' },
  { to: memberPaths.activities, key: 'activities', icon: Clock3, capability: null },
  { to: memberPaths.planning, key: 'planning', icon: CalendarDays, capability: 'planning' },
  { to: memberPaths.catalog, key: 'catalog', icon: Boxes, capability: 'catalog' },
  { to: memberPaths.finance, key: 'finance', icon: WalletCards, capability: 'finance' },
  { to: '/admin', key: 'administration', icon: Settings, capability: 'administration' },
] as const;

/** Module keys rendered directly in the mobile bottom navigation. */
export const mobilePrimaryModuleKeys: ReadonlySet<string> = new Set(['overview', 'book', 'activities']);
