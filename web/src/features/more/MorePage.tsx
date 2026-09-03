import { Link } from '@tanstack/react-router';
import Bell from 'lucide-react/dist/esm/icons/bell';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import { useTranslation } from 'react-i18next';
import { canOpenStatistics, canUsePlanning, hasGroupCapability } from '@/app/groupCapabilities';
import { memberPaths } from '@/app/paths';
import { useActiveGroup } from '@/app/useActiveGroup';
import { isSystemAdministrator } from '@/app/useSession';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { LogoutButton } from '@/components/auth/LogoutButton';
import styles from './MorePage.module.css';
import { NotificationBadge } from '@/features/notifications/NotificationBadge';
import { useUnreadNotificationCount } from '@/features/notifications/NotificationSummaryContext';
import { mobilePrimaryModuleKeys, moduleNavigationItems } from '@/components/layout/navigationItems';

const overflowModules = moduleNavigationItems.filter((item) => !mobilePrimaryModuleKeys.has(item.key));

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
  const canPlan = Boolean(activeGroup.planningEnabled && canUsePlanning(grants));
  return (
    <Page title={t('more.title')}>
      <section className={styles.profile}>
        <Avatar name={session.user.displayName} size="large" src={session.user.avatarUrl} />
        <div><strong>{session.user.displayName}</strong><span>{session.user.email}</span><small>{activeGroup.name}</small></div>
      </section>
      <nav aria-label={t('nav.additional')} className={styles.links}>
        {overflowModules
          .filter((item) => {
            if (item.capability === 'planning') return canPlan;
            if (item.capability === 'statistics') return canOpenStatistics(activeGroup);
            if (item.capability === 'administration') return hasGroupCapability(grants, item.capability) || isSystemAdministrator(session);
            if (item.capability === 'catalog' || item.capability === 'finance') return hasGroupCapability(grants, item.capability);
            return false;
          })
          .map(({ to, key, icon: Icon }) => <Link key={to} to={to}><Icon aria-hidden="true" size={23} /><span>{t(`nav.${key}`)}</span><ChevronRight aria-hidden="true" size={20} /></Link>)}
        <Link to={memberPaths.notifications}><Bell aria-hidden="true" size={23} /><span>{t('nav.notifications')}</span><span className={styles.end}><NotificationBadge count={unreadCount} /><ChevronRight aria-hidden="true" size={20} /></span></Link>
        <Link to="/account"><CircleUserRound aria-hidden="true" size={23} /><span>{t('nav.account')}</span><ChevronRight aria-hidden="true" size={20} /></Link>
        <LogoutButton className={styles.logout} showChevron />
      </nav>
    </Page>
  );
}
