import { Link, useRouterState } from '@tanstack/react-router';
import Bell from 'lucide-react/dist/esm/icons/bell';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { memberPaths } from '@/app/paths';
import { canOpenBooking, canUsePlanning, hasGroupCapability } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { isSystemAdministrator, useInstanceCapabilities } from '@/app/useSession';
import { Brand } from '@/components/brand/Brand';
import { LogoutButton } from '@/components/auth/LogoutButton';
import { GroupSelector } from './GroupSelector';
import { moduleNavigationItems } from './navigationItems';
import { visibleSidebarItemCount } from './sidebarOverflow';
import styles from './Sidebar.module.css';
import { NotificationBadge } from '@/features/notifications/NotificationBadge';
import { useUnreadNotificationCount } from '@/features/notifications/NotificationSummaryContext';

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
  const canPlan = Boolean(activeGroup?.planningEnabled && canUsePlanning(grants));
  const unreadCount = useUnreadNotificationCount();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigationRef = useRef<HTMLElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const visibleItemCountRef = useRef<number>(moduleNavigationItems.length);
  const [visibleItemCount, setVisibleItemCount] = useState<number>(moduleNavigationItems.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPosition, setOverflowPosition] = useState({ left: 0, top: 0 });
  const availableNavigation = moduleNavigationItems
    .filter((item) => item.key !== 'book' || canBook)
    .filter((item) => item.key !== 'planning' || canPlan)
    .filter((item) => item.key !== 'catalog' || canManageCatalog)
    .filter((item) => item.key !== 'finance' || canManageFinance)
    .filter((item) => item.key !== 'administration' || canManageAdministration);
  const visibleNavigation = availableNavigation.slice(0, visibleItemCount);
  const overflowNavigation = availableNavigation.slice(visibleItemCount);
  const overflowActive = overflowNavigation.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation) return undefined;
    const update = () => {
      const gap = Number.parseFloat(getComputedStyle(navigation).rowGap) || 8;
      const next = visibleSidebarItemCount(availableNavigation.length, navigation.clientHeight, collapsed ? 48 : 56, gap);
      if (visibleItemCountRef.current === next) return;
      visibleItemCountRef.current = next;
      setVisibleItemCount(next);
      setOverflowOpen(false);
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [availableNavigation.length, collapsed]);

  useEffect(() => {
    if (!overflowOpen) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!overflowButtonRef.current?.contains(target) && !overflowMenuRef.current?.contains(target)) setOverflowOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOverflowOpen(false);
        overflowButtonRef.current?.focus();
      }
    };
    const closeOnResize = () => setOverflowOpen(false);
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnKeyDown);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnKeyDown);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [overflowOpen]);

  const toggleOverflow = () => {
    if (!overflowOpen) {
      const rect = overflowButtonRef.current?.getBoundingClientRect();
      if (rect) {
        const estimatedHeight = Math.min(overflowNavigation.length * 52 + 16, window.innerHeight - 16);
        setOverflowPosition({ left: rect.right + 8, top: Math.max(8, Math.min(rect.top, window.innerHeight - estimatedHeight - 8)) });
      }
    }
    setOverflowOpen((current) => !current);
  };
  const closeAfterNavigation = () => {
    setOverflowOpen(false);
    onNavigate?.();
  };

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
      <nav aria-label={t('nav.primary')} className={styles.nav} ref={navigationRef}>
        {visibleNavigation.map(({ to, key, icon: Icon }) => (
          <Link
            activeOptions={{ exact: key !== 'planning' }}
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
        {overflowNavigation.length > 0 ? <>
          <button aria-controls="sidebar-overflow-menu" aria-expanded={overflowOpen} aria-haspopup="menu" aria-label={t('nav.more')} className={`${styles.link} ${overflowActive ? styles.active : ''}`} onClick={toggleOverflow} ref={overflowButtonRef} title={collapsed ? t('nav.more') : undefined} type="button">
            <Ellipsis aria-hidden="true" size={25} strokeWidth={1.8} />
            <span className={styles.linkLabel}>{t('nav.more')}</span>
          </button>
          {overflowOpen ? <div aria-label={t('nav.more')} className={styles.overflowMenu} id="sidebar-overflow-menu" ref={overflowMenuRef} role="menu" style={overflowPosition}>
            {overflowNavigation.map(({ to, key, icon: Icon }) => <Link activeProps={{ className: styles.overflowMenuActive }} aria-label={t(`nav.${key}`)} className={styles.overflowMenuLink} key={to} onClick={closeAfterNavigation} role="menuitem" to={to}><Icon aria-hidden="true" size={21} strokeWidth={1.8} /><span>{t(`nav.${key}`)}</span></Link>)}
          </div> : null}
        </> : null}
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
