import { Link } from '@tanstack/react-router';
import Bell from 'lucide-react/dist/esm/icons/bell';
import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import Boxes from 'lucide-react/dist/esm/icons/boxes';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import ChartNoAxesCombined from 'lucide-react/dist/esm/icons/chart-no-axes-combined';
import Home from 'lucide-react/dist/esm/icons/home';
import Settings from 'lucide-react/dist/esm/icons/settings';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useTranslation } from 'react-i18next';
import { memberPaths } from '@/app/paths';
import { canOpenBooking, canOpenStatistics, hasGroupCapability } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { isSystemAdministrator, useInstanceCapabilities } from '@/app/useSession';
import { Brand } from '@/components/brand/Brand';
import { LogoutButton } from '@/components/auth/LogoutButton';
import { GroupSelector } from './GroupSelector';
import styles from './Sidebar.module.css';
import { NotificationBadge } from '@/features/notifications/NotificationBadge';
import { useUnreadNotificationCount } from '@/features/notifications/NotificationSummaryContext';

const primaryNavigation = [
  { to: memberPaths.overview, key: 'overview', icon: Home },
  { to: memberPaths.booking, key: 'book', icon: BookOpenCheck },
  { to: '/activities', key: 'activities', icon: Clock3 },
  { to: memberPaths.statistics, key: 'statistics', icon: ChartNoAxesCombined },
  { to: memberPaths.catalog, key: 'catalog', icon: Boxes },
  { to: memberPaths.finance, key: 'finance', icon: WalletCards },
  { to: '/admin', key: 'administration', icon: Settings },
] as const;

/** Properties accepted by the responsive desktop sidebar. */
export interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onNavigate?: () => void;
}

/**
 * Renders the desktop navigation rail and role-aware destinations.
 *
 * @param props - Current tablet-rail state and its state-change callback.
 * @returns A localized group selector and navigation landmark.
 */
export function Sidebar({ collapsed, onCollapsedChange, onNavigate }: SidebarProps) {
  const { t } = useTranslation();
  const { session, activeGroupId, setActiveGroupId } = useActiveGroup();
  const instanceCapabilities = useInstanceCapabilities();
  const activeGroup = session.groups.find((group) => group.id === activeGroupId);
  const grants = activeGroup?.membership?.effectiveGrants;
  const canManageCatalog = hasGroupCapability(grants, 'catalog');
  const canManageFinance = hasGroupCapability(grants, 'finance');
  const canManageAdministration = hasGroupCapability(grants, 'administration') || isSystemAdministrator(session);
  const canBook = canOpenBooking(grants);
  const canViewStatistics = activeGroup ? canOpenStatistics(activeGroup) : false;
  const unreadCount = useUnreadNotificationCount();

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`} data-collapsed={collapsed} id="desktop-sidebar">
      <div className={styles.sidebarHeader}>
        <Brand className={styles.brand} name={instanceCapabilities.instanceName} />
        <button
          aria-controls="desktop-sidebar"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
          className={styles.collapseButton}
          onClick={() => onCollapsedChange(!collapsed)}
          title={t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
          type="button"
        >
          <span aria-hidden="true" className={styles.handleHitArea} />
          {collapsed ? <ChevronRight aria-hidden="true" size={14} strokeWidth={2.4} /> : <ChevronLeft aria-hidden="true" size={14} strokeWidth={2.4} />}
        </button>
      </div>
      <label className={styles.groupLabel} htmlFor="desktop-group">{t('nav.group')}</label>
      <GroupSelector ariaLabel={t('nav.selectGroup')} className={styles.groupSelector} compact={collapsed} groups={session.groups} id="desktop-group" onChange={setActiveGroupId} value={activeGroupId} />
      <nav aria-label={t('nav.primary')} className={styles.nav}>
        {primaryNavigation
          .filter((item) => item.key !== 'book' || canBook)
          .filter((item) => item.key !== 'statistics' || canViewStatistics)
          .filter((item) => item.key !== 'catalog' || canManageCatalog)
          .filter((item) => item.key !== 'finance' || canManageFinance)
          .filter((item) => item.key !== 'administration' || canManageAdministration)
          .map(({ to, key, icon: Icon }) => (
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ className: styles.active }}
            aria-label={t(`nav.${key}`)}
            className={styles.link}
            key={to}
            onClick={onNavigate}
            title={collapsed ? t(`nav.${key}`) : undefined}
            to={to}
          >
            <Icon aria-hidden="true" size={25} strokeWidth={1.8} />
            <span className={styles.linkLabel}>{t(`nav.${key}`)}</span>
          </Link>
          ))}
      </nav>
      <div className={styles.bottom}>
        <Link aria-label={t('nav.notifications')} activeProps={{ className: styles.active }} className={styles.link} onClick={onNavigate} title={collapsed ? t('nav.notifications') : undefined} to={memberPaths.notifications}>
          <span className={styles.notificationIcon}>
            <Bell aria-hidden="true" size={23} strokeWidth={1.8} />
            <NotificationBadge className={styles.badge} count={unreadCount} />
          </span>
          <span className={styles.linkLabel}>{t('nav.notifications')}</span>
        </Link>
        <Link aria-label={t('nav.account')} activeProps={{ className: styles.active }} className={styles.link} onClick={onNavigate} title={collapsed ? t('nav.account') : undefined} to="/account">
          <CircleUserRound aria-hidden="true" size={23} strokeWidth={1.8} />
          <span className={styles.linkLabel}>{t('nav.account')}</span>
        </Link>
        <LogoutButton className={styles.link} />
      </div>
    </aside>
  );
}
