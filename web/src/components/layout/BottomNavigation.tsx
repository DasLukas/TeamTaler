import { Link, useRouterState } from '@tanstack/react-router';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';
import { useTranslation } from 'react-i18next';
import { memberPaths } from '@/app/paths';
import { canOpenBooking } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import styles from './BottomNavigation.module.css';
import { NotificationBadge } from '@/features/notifications/NotificationBadge';
import { useUnreadNotificationCount } from '@/features/notifications/NotificationSummaryContext';
import { mobilePrimaryModuleKeys, moduleNavigationItems } from './navigationItems';

const overflowPaths = new Set<string>([
  memberPaths.more,
  memberPaths.notifications,
  memberPaths.planning,
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
  const items = [
    ...moduleNavigationItems.filter((item) => mobilePrimaryModuleKeys.has(item.key)),
    { to: memberPaths.more, key: 'more', icon: Ellipsis, capability: null },
  ] as const;
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
