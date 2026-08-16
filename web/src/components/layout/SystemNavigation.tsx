import { Link } from '@tanstack/react-router';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import Settings from 'lucide-react/dist/esm/icons/settings';
import { useTranslation } from 'react-i18next';
import { useInstanceCapabilities } from '@/app/useSession';
import { LogoutButton } from '@/components/auth/LogoutButton';
import { Brand } from '@/components/brand/Brand';
import bottomStyles from './BottomNavigation.module.css';
import headerStyles from './MobileHeader.module.css';
import sidebarStyles from './Sidebar.module.css';

/** Properties accepted by the navigation for a group-less system administrator. */
export interface SystemNavigationProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onNavigate?: () => void;
}

const destinations = [
  { to: '/admin', labelKey: 'nav.system', icon: Settings },
  { to: '/account', labelKey: 'nav.account', icon: CircleUserRound },
] as const;

/**
 * Renders the only destinations available to a system administrator without a group.
 *
 * @param props - Desktop rail state and callbacks.
 * @returns Responsive System, Account, and Logout navigation.
 */
export function SystemNavigation({ collapsed, onCollapsedChange, onNavigate }: SystemNavigationProps) {
  const { t } = useTranslation();
  const capabilities = useInstanceCapabilities();
  return (
    <>
      <aside className={`${sidebarStyles.sidebar} ${collapsed ? sidebarStyles.collapsed : ''}`} data-collapsed={collapsed} id="desktop-sidebar">
        <div className={sidebarStyles.sidebarHeader}>
          <Brand className={sidebarStyles.brand} name={capabilities.instanceName} />
          <button
            aria-controls="desktop-sidebar"
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
            className={sidebarStyles.collapseButton}
            onClick={() => onCollapsedChange(!collapsed)}
            title={t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
            type="button"
          >
            <span aria-hidden="true" className={sidebarStyles.handleHitArea} />
            {collapsed ? <ChevronRight aria-hidden="true" size={14} strokeWidth={2.4} /> : <ChevronLeft aria-hidden="true" size={14} strokeWidth={2.4} />}
          </button>
        </div>
        <nav aria-label={t('nav.primary')} className={sidebarStyles.nav}>
          {destinations.map(({ to, labelKey, icon: Icon }) => (
            <Link activeProps={{ className: sidebarStyles.active }} aria-label={t(labelKey)} className={sidebarStyles.link} key={to} onClick={onNavigate} title={collapsed ? t(labelKey) : undefined} to={to}>
              <Icon aria-hidden="true" size={24} strokeWidth={1.8} />
              <span className={sidebarStyles.linkLabel}>{t(labelKey)}</span>
            </Link>
          ))}
        </nav>
        <div className={sidebarStyles.bottom}><LogoutButton className={sidebarStyles.link} /></div>
      </aside>
      <header className={headerStyles.header}><Brand name={capabilities.instanceName} /></header>
      <nav aria-label={t('nav.mobilePrimary')} className={bottomStyles.nav}>
        {destinations.map(({ to, labelKey, icon: Icon }) => (
          <Link activeProps={{ className: bottomStyles.active }} className={bottomStyles.link} key={to} to={to}>
            <Icon aria-hidden="true" size={27} strokeWidth={1.8} />
            <span>{t(labelKey)}</span>
          </Link>
        ))}
        <LogoutButton className={bottomStyles.link} />
      </nav>
    </>
  );
}
