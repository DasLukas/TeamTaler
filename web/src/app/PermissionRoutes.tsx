import { Navigate, Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { canOpenBooking, preferredMemberPath } from './groupCapabilities';
import { useActiveGroup, useOptionalActiveGroup } from './useActiveGroup';
import { StatePanel } from '@/components/ui/StatePanel';
import { BookingPage } from '@/features/bookings/BookingPage';

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
