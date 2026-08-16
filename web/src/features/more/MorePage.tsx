import { Link } from '@tanstack/react-router';
import Boxes from 'lucide-react/dist/esm/icons/boxes';
import Bell from 'lucide-react/dist/esm/icons/bell';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import Settings from 'lucide-react/dist/esm/icons/settings';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useTranslation } from 'react-i18next';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { memberPaths } from '@/app/paths';
import { useActiveGroup } from '@/app/useActiveGroup';
import { isSystemAdministrator } from '@/app/useSession';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { LogoutButton } from '@/components/auth/LogoutButton';
import styles from './MorePage.module.css';
import { NotificationBadge } from '@/features/notifications/NotificationBadge';
import { useUnreadNotificationCount } from '@/features/notifications/NotificationSummaryContext';

const links = [
  { to: memberPaths.finance, labelKey: 'nav.finance', icon: WalletCards, capability: 'finance' },
  { to: memberPaths.catalog, labelKey: 'nav.catalog', icon: Boxes, capability: 'catalog' },
  { to: '/admin', labelKey: 'nav.administration', icon: Settings, capability: 'administration' },
  { to: '/account', labelKey: 'nav.account', icon: CircleUserRound, capability: null },
] as const;

/**
 * Renders the mobile overflow destination for secondary application areas.
 *
 * @returns A localized profile summary and role-aware navigation list.
 */
export function MorePage() {
  const { t } = useTranslation();
  const { session, activeGroup } = useActiveGroup();
  const grants = activeGroup.membership?.effectiveGrants;
  const unreadCount = useUnreadNotificationCount();
  return (
    <Page title={t('more.title')}>
      <section className={styles.profile}>
        <Avatar name={session.user.displayName} size="large" src={session.user.avatarUrl} />
        <div><strong>{session.user.displayName}</strong><span>{session.user.email}</span><small>{activeGroup.name}</small></div>
      </section>
      <nav aria-label={t('nav.additional')} className={styles.links}>
        <Link to={memberPaths.notifications}><Bell aria-hidden="true" size={23} /><span>{t('nav.notifications')}</span><span className={styles.end}><NotificationBadge count={unreadCount} /><ChevronRight aria-hidden="true" size={20} /></span></Link>
        {links.filter((item) => item.capability === null || hasGroupCapability(grants, item.capability) || item.to === '/admin' && isSystemAdministrator(session)).map(({ to, labelKey, icon: Icon }) => <Link key={to} to={to}><Icon aria-hidden="true" size={23} /><span>{t(labelKey)}</span><ChevronRight aria-hidden="true" size={20} /></Link>)}
        <LogoutButton className={styles.logout} showChevron />
      </nav>
    </Page>
  );
}
