import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError, api, isDevelopmentDemoEnabled } from '@/api/client';
import { GroupProvider } from '@/app/GroupContext';
import { useActiveGroup } from '@/app/useActiveGroup';
import { StatePanel } from '@/components/ui/StatePanel';
import { NotificationSummaryProvider } from '@/features/notifications/NotificationSummaryProvider';
import { BottomNavigation } from './BottomNavigation';
import { MobileHeader } from './MobileHeader';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

/** Remounts route-local state whenever the user changes the active group. */
function GroupScopedOutlet() {
  const { activeGroupId } = useActiveGroup();
  return <RouteOutlet key={activeGroupId} />;
}

/** Owns the route subtree that is reset by {@link GroupScopedOutlet}. */
function RouteOutlet() {
  return <Outlet />;
}

/**
 * Renders the authenticated shell shared by group-scoped routes.
 *
 * @returns Navigation chrome, route content, or a localized session state.
 */
export function AppShell() {
  const { t } = useTranslation();
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: api.getSession });

  if (sessionQuery.isLoading) return <main className={styles.center}><StatePanel kind="loading" /></main>;
  if (sessionQuery.error instanceof ApiError && sessionQuery.error.problem.status === 401) return <Navigate to="/login" />;
  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <main className={styles.center}>
        <StatePanel kind="error" message={t('appShell.sessionError')} actionLabel={t('common.retry')} onAction={() => void sessionQuery.refetch()} />
      </main>
    );
  }
  if (sessionQuery.data.groups.length === 0) {
    return <main className={styles.center}><StatePanel kind="empty" title={t('appShell.noGroupTitle')} message={t('appShell.noGroupMessage')} /></main>;
  }

  return (
    <GroupProvider session={sessionQuery.data}>
      <NotificationSummaryProvider>
        <div className={styles.shell}>
          <Sidebar />
          <MobileHeader />
          <main className={styles.main} id="main-content">
            {isDevelopmentDemoEnabled && sessionQuery.data.demo ? (
              <div className={styles.demo} role="status">{t('appShell.demoBanner')}</div>
            ) : null}
            <GroupScopedOutlet />
          </main>
          <BottomNavigation />
        </div>
      </NotificationSummaryProvider>
    </GroupProvider>
  );
}
