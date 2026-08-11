import { Link, useRouterState } from '@tanstack/react-router';
import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';
import Home from 'lucide-react/dist/esm/icons/home';
import { useTranslation } from 'react-i18next';
import { memberPaths } from '@/app/paths';
import { canOpenBooking } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import styles from './BottomNavigation.module.css';
import { NotificationBadge } from '@/features/notifications/NotificationBadge';
import { useUnreadNotificationCount } from '@/features/notifications/NotificationSummaryContext';

const items = [
  { to: memberPaths.overview, key: 'overview', icon: Home },
  { to: memberPaths.booking, key: 'book', icon: BookOpenCheck },
  { to: '/activities', key: 'activities', icon: Clock3 },
  { to: memberPaths.more, key: 'more', icon: Ellipsis },
] as const;

const overflowPaths = new Set<string>([
  memberPaths.more,
  memberPaths.notifications,
  memberPaths.finance,
  memberPaths.catalog,
  '/admin',
  '/account',
]);

/**
 * Renders the fixed four-destination mobile primary navigation.
 *
 * @returns A localized navigation landmark.
 */
export function BottomNavigation() {
  const { t } = useTranslation();
  const unreadCount = useUnreadNotificationCount();
  const { activeGroup } = useActiveGroup();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const overflowActive = overflowPaths.has(pathname);
  return (
    <nav aria-label={t('nav.mobilePrimary')} className={styles.nav}>
      {items.filter((item) => item.key !== 'book' || canOpenBooking(activeGroup.membership?.effectiveGrants)).map(({ to, key, icon: Icon }) => (
        <Link activeOptions={{ exact: true }} activeProps={{ className: styles.active }} className={`${styles.link} ${key === 'more' && overflowActive ? styles.active : ''}`} key={to} to={to}>
          <span className={styles.iconWrap}><Icon aria-hidden="true" size={27} strokeWidth={1.8} />{key === 'more' ? <NotificationBadge className={styles.badge} count={unreadCount} /> : null}</span>
          <span>{t(`nav.${key}`)}</span>
        </Link>
      ))}
    </nav>
  );
}
