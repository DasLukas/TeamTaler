import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api, isDevelopmentDemoEnabled } from '@/api/client';
import { GroupProvider } from '@/app/GroupContext';
import { SessionProvider } from '@/app/SessionContext';
import { useActiveGroup } from '@/app/useActiveGroup';
import { DEFAULT_INSTANCE_CAPABILITIES, isSystemAdministrator } from '@/app/useSession';
import { StatePanel } from '@/components/ui/StatePanel';
import { LegalFooter } from '@/components/legal/LegalLinks';
import { NotificationSummaryProvider } from '@/features/notifications/NotificationSummaryProvider';
import { preservePendingNotificationFromHref } from '@/features/notifications/notificationDeepLink';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BottomNavigation } from './BottomNavigation';
import { MobileHeader } from './MobileHeader';
import { Sidebar } from './Sidebar';
import { SystemNavigation } from './SystemNavigation';
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

/** Persists a safe push deep link before replacing an expired session with login. */
function SessionExpiredRedirect({ href }: { href: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    preservePendingNotificationFromHref(href);
    queueMicrotask(() => {
      if (active) setReady(true);
    });
    return () => { active = false; };
  }, [href]);
  return ready ? <Navigate replace to="/login" /> : <main className={styles.center}><StatePanel kind="loading" /></main>;
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

/** Keeps public legal links reachable while the authenticated shell displays a standalone state. */
function StandaloneShellState({ children }: { children: ReactNode }) {
  return <div className={styles.standalone}><main className={styles.center}>{children}</main><LegalFooter /></div>;
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
  const instanceCapabilitiesQuery = useQuery({
    queryKey: ['instance-capabilities'],
    queryFn: api.getInstanceCapabilities,
    retry: false,
    staleTime: 60_000,
  });
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

  if (sessionQuery.isLoading) return <StandaloneShellState><StatePanel kind="loading" /></StandaloneShellState>;
  if (sessionQuery.error instanceof ApiError && sessionQuery.error.problem.status === 401) {
    return <SessionExpiredRedirect href={window.location.href} />;
  }
  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <StandaloneShellState>
        <StatePanel kind="error" message={t('appShell.sessionError')} actionLabel={t('common.retry')} onAction={() => void sessionQuery.refetch()} />
      </StandaloneShellState>
    );
  }
  if (sessionQuery.data.groups.length === 0 && !isSystemAdministrator(sessionQuery.data)) {
    return <StandaloneShellState><StatePanel kind="empty" title={t('appShell.noGroupTitle')} message={t('appShell.noGroupMessage')} /></StandaloneShellState>;
  }

  const instanceCapabilities = instanceCapabilitiesQuery.data ?? DEFAULT_INSTANCE_CAPABILITIES;
  const shellClassName = `${styles.shell} ${displayedSidebarCollapsed ? styles.sidebarCollapsed : ''} ${usesOverlaySidebar ? styles.sidebarOverlayMode : ''}`;
  const navigationProps = {
    collapsed: displayedSidebarCollapsed,
    onCollapsedChange: changeSidebarCollapsed,
    onNavigate: () => setOverlaySidebarExpanded(false),
  };
  const sharedContent = (
    <>
      {usesOverlaySidebar && overlaySidebarExpanded ? (
        <button aria-label={t('nav.collapseSidebar')} className={styles.sidebarBackdrop} onClick={() => setOverlaySidebarExpanded(false)} type="button" />
      ) : null}
      <main className={styles.main} id="main-content">
        {isDevelopmentDemoEnabled && sessionQuery.data.demo ? <div className={styles.demo} role="status">{t('appShell.demoBanner')}</div> : null}
        {instanceCapabilities.maintenanceMode ? (
          <div className={styles.maintenance} role="status">{instanceCapabilities.maintenanceMessage || t('appShell.maintenanceBanner')}</div>
        ) : null}
        {sessionQuery.data.groups.length > 0 ? <GroupScopedOutlet /> : <RouteOutlet />}
        <LegalFooter />
      </main>
    </>
  );

  if (sessionQuery.data.groups.length === 0) {
    return (
      <SessionProvider instanceCapabilities={instanceCapabilities} session={sessionQuery.data}>
        <div className={shellClassName} data-sidebar-collapsed={displayedSidebarCollapsed}>
          <SystemNavigation {...navigationProps} />
          {sharedContent}
        </div>
      </SessionProvider>
    );
  }

  return (
    <SessionProvider instanceCapabilities={instanceCapabilities} session={sessionQuery.data}>
      <GroupProvider session={sessionQuery.data}>
        <NotificationSummaryProvider>
          <div className={shellClassName} data-sidebar-collapsed={displayedSidebarCollapsed}>
            <Sidebar {...navigationProps} />
            <MobileHeader />
            {sharedContent}
            <BottomNavigation />
          </div>
        </NotificationSummaryProvider>
      </GroupProvider>
    </SessionProvider>
  );
}
