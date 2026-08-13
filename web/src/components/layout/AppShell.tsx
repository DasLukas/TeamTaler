import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api, isDevelopmentDemoEnabled } from '@/api/client';
import { GroupProvider } from '@/app/GroupContext';
import { useActiveGroup } from '@/app/useActiveGroup';
import { StatePanel } from '@/components/ui/StatePanel';
import { NotificationSummaryProvider } from '@/features/notifications/NotificationSummaryProvider';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BottomNavigation } from './BottomNavigation';
import { MobileHeader } from './MobileHeader';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

const SIDEBAR_PREFERENCE_STORAGE_KEY = 'teamtaler:sidebar:v1';

/**
 * Reads the locally stored desktop-sidebar preference without blocking app startup when storage is unavailable.
 *
 * @returns Whether the tablet navigation rail should start collapsed.
 */
function readSidebarCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PREFERENCE_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const [overlaySidebarExpanded, setOverlaySidebarExpanded] = useState(false);
  const usesOverlaySidebar = useMediaQuery('(min-width: 768px) and (max-width: 959px)');
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: api.getSession });
  const displayedSidebarCollapsed = usesOverlaySidebar ? !overlaySidebarExpanded : sidebarCollapsed;

  useEffect(() => {
    if (!usesOverlaySidebar || !overlaySidebarExpanded) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlaySidebarExpanded(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [overlaySidebarExpanded, usesOverlaySidebar]);

  const changeSidebarCollapsed = (collapsed: boolean) => {
    if (usesOverlaySidebar) {
      setOverlaySidebarExpanded(!collapsed);
      return;
    }
    setSidebarCollapsed(collapsed);
    try {
      window.localStorage.setItem(SIDEBAR_PREFERENCE_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
      // The in-memory preference still works when private browsing blocks storage.
    }
  };

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
        <div
          className={`${styles.shell} ${displayedSidebarCollapsed ? styles.sidebarCollapsed : ''} ${usesOverlaySidebar ? styles.sidebarOverlayMode : ''}`}
          data-sidebar-collapsed={displayedSidebarCollapsed}
        >
          <Sidebar collapsed={displayedSidebarCollapsed} onCollapsedChange={changeSidebarCollapsed} onNavigate={() => setOverlaySidebarExpanded(false)} />
          {usesOverlaySidebar && overlaySidebarExpanded ? (
            <button
              aria-label={t('nav.collapseSidebar')}
              className={styles.sidebarBackdrop}
              onClick={() => setOverlaySidebarExpanded(false)}
              type="button"
            />
          ) : null}
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
