import { Link } from '@tanstack/react-router';
import BarChart3 from 'lucide-react/dist/esm/icons/bar-chart-3';
import Bell from 'lucide-react/dist/esm/icons/bell';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import Settings from 'lucide-react/dist/esm/icons/settings';
import { useTranslation } from 'react-i18next';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { LogoutButton } from '@/components/auth/LogoutButton';
import styles from './MorePage.module.css';

const links = [
  { to: '/reports', labelKey: 'nav.reports', icon: BarChart3 },
  { to: '/notifications', labelKey: 'nav.notifications', icon: Bell },
  { to: '/account', labelKey: 'nav.account', icon: CircleUserRound },
  { to: '/admin', labelKey: 'nav.administration', icon: Settings },
] as const;

/**
 * Renders the mobile overflow destination for secondary application areas.
 *
 * @returns A localized profile summary and role-aware navigation list.
 */
export function MorePage() {
  const { t } = useTranslation();
  const { session, activeGroup } = useActiveGroup();
  const roles = activeGroup.membership?.roles ?? [];
  const canManage = roles.some((role) => role === 'ADMIN' || role === 'FINANCE_MANAGER' || role === 'CATALOG_MANAGER');
  return (
    <Page title={t('more.title')}>
      <section className={styles.profile}>
        <Avatar name={session.user.displayName} size="large" />
        <div><strong>{session.user.displayName}</strong><span>{session.user.email}</span><small>{activeGroup.name}</small></div>
      </section>
      <nav aria-label={t('nav.additional')} className={styles.links}>
        {links.filter((item) => item.to !== '/admin' || canManage).map(({ to, labelKey, icon: Icon }) => <Link key={to} to={to}><Icon aria-hidden="true" size={23} /><span>{t(labelKey)}</span><ChevronRight aria-hidden="true" size={20} /></Link>)}
        <LogoutButton className={styles.logout} showChevron />
      </nav>
    </Page>
  );
}
