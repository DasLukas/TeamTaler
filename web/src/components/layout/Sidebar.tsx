import { Link } from '@tanstack/react-router';
import BarChart3 from 'lucide-react/dist/esm/icons/bar-chart-3';
import Bell from 'lucide-react/dist/esm/icons/bell';
import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import Home from 'lucide-react/dist/esm/icons/home';
import Settings from 'lucide-react/dist/esm/icons/settings';
import { useTranslation } from 'react-i18next';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Brand } from '@/components/brand/Brand';
import { LogoutButton } from '@/components/auth/LogoutButton';
import styles from './Sidebar.module.css';

const primaryNavigation = [
  { to: '/', key: 'overview', icon: Home },
  { to: '/book', key: 'book', icon: BookOpenCheck },
  { to: '/activities', key: 'activities', icon: Clock3 },
  { to: '/reports', key: 'reports', icon: BarChart3 },
  { to: '/admin', key: 'administration', icon: Settings },
] as const;

/**
 * Renders the desktop navigation rail and role-aware destinations.
 *
 * @returns A localized group selector and navigation landmark.
 */
export function Sidebar() {
  const { t } = useTranslation();
  const { session, activeGroupId, setActiveGroupId } = useActiveGroup();
  const activeGroup = session.groups.find((group) => group.id === activeGroupId);
  const roles = activeGroup?.membership?.roles ?? [];
  const canManage = roles.some((role) => role === 'ADMIN' || role === 'FINANCE_MANAGER' || role === 'CATALOG_MANAGER');

  return (
    <aside className={styles.sidebar}>
      <Brand imageAlt={activeGroup?.logoUrl ? t('brand.groupMarkAlt', { group: activeGroup.name }) : undefined} imageUrl={activeGroup?.logoUrl} />
      <label className={styles.groupLabel} htmlFor="desktop-group">{t('nav.group')}</label>
      <div className={styles.groupSelectWrap}>
        <select id="desktop-group" onChange={(event) => setActiveGroupId(event.target.value)} value={activeGroupId}>
          {session.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <ChevronDown aria-hidden="true" size={18} />
      </div>
      <nav aria-label={t('nav.primary')} className={styles.nav}>
        {primaryNavigation.filter((item) => item.key !== 'administration' || canManage).map(({ to, key, icon: Icon }) => (
          <Link activeOptions={{ exact: to === '/' }} activeProps={{ className: styles.active }} className={styles.link} key={to} to={to}>
            <Icon aria-hidden="true" size={25} strokeWidth={1.8} />
            <span>{t(`nav.${key}`)}</span>
          </Link>
        ))}
      </nav>
      <div className={styles.bottom}>
        <Link activeProps={{ className: styles.active }} className={styles.link} to="/notifications">
          <Bell aria-hidden="true" size={23} strokeWidth={1.8} />
          <span>{t('nav.notifications')}</span>
        </Link>
        <Link activeProps={{ className: styles.active }} className={styles.link} to="/account">
          <CircleUserRound aria-hidden="true" size={23} strokeWidth={1.8} />
          <span>{t('nav.account')}</span>
        </Link>
        <LogoutButton className={styles.link} />
      </div>
    </aside>
  );
}
