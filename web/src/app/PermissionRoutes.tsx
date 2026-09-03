import { Navigate, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { canOpenBooking, canOpenStatistics, preferredMemberPath } from './groupCapabilities';
import { useActiveGroup, useOptionalActiveGroup } from './useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { BookingPage } from '@/features/bookings/BookingPage';

const StatisticsPage = lazy(() => import('@/features/statistics/StatisticsPage').then((module) => ({ default: module.StatisticsPage })));

/** Redirects the active group to its highest-priority permitted workspace. */
export function PreferredWorkspaceRedirect() {
  const { activeGroup } = useActiveGroup();
  return <Navigate replace to={preferredMemberPath(activeGroup.membership?.effectiveGrants)} />;
}

/** Prevents group-scoped route components from mounting without an active group. */
export function GroupRequiredRoute() {
  return useOptionalActiveGroup() ? <Outlet /> : <Navigate replace to="/admin" />;
}

/**
 * Prevents unauthorized booking queries from mounting while preserving a
 * direct-link explanation for memberships without booking permissions.
 */
export function BookingPermissionRoute() {
  const { t } = useTranslation();
  const { activeGroup } = useActiveGroup();
  if (!canOpenBooking(activeGroup.membership?.effectiveGrants)) {
    return <StatePanel kind="empty" message={t('booking.noAccessMessage')} title={t('booking.noAccessTitle')} />;
  }
  return <BookingPage />;
}

/**
 * Prevents disabled or unauthorized statistics code and queries from mounting.
 *
 * @returns The lazy statistics route or a neutral feature/access explanation.
 */
export function StatisticsPermissionRoute() {
  const { t } = useTranslation();
  const { activeGroup } = useActiveGroup();
  if (!activeGroup.statisticsEnabled) {
    return <Page title={t('statistics.title')}><StatePanel kind="empty" message={t('statistics.disabledMessage')} title={t('statistics.disabledTitle')} /></Page>;
  }
  if (!canOpenStatistics(activeGroup)) {
    return <Page title={t('statistics.title')}><StatePanel kind="error" message={t('statistics.noAccessMessage')} title={t('statistics.noAccessTitle')} /></Page>;
  }
  return <Suspense fallback={<Page title={t('statistics.title')}><StatePanel kind="loading" /></Page>}><StatisticsPage /></Suspense>;
}
