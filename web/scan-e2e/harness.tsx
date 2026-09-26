import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/api/client';
import { ActiveGroupContext } from '../src/app/active-group-context';
import { demoCategories, demoDashboard, demoMembers, demoSession } from '../src/demo/data';
import { BookingPage } from '../src/features/bookings/BookingPage';
import '../src/i18n';
import '../src/styles/global.css';

const group = { ...demoSession.groups[0], kioskEnabled: true, membership: { ...demoSession.groups[0].membership!, effectiveGrants: [
  { permission: 'CREATE_OWN_BOOKING' as const, scope: { type: 'GROUP' as const } },
  { permission: 'USE_KIOSK' as const, scope: { type: 'GROUP' as const } },
] } };
const session = { ...demoSession, groups: [group] };
api.getSession = async () => session;
api.getCategories = async () => demoCategories;
api.getBookingContext = async () => ({
  openPeriod: demoDashboard.currentPeriod, ownBalance: demoDashboard.openBalance,
  currentMembership: demoMembers[0], targets: [{ membershipId: demoMembers[0].id, displayName: demoMembers[0].displayName, isTemporaryGuest: false }],
  canBookForGuests: false, ownBookingReasonMode: 'OFF', foreignBookingReasonMode: 'REQUIRED', foreignBookingReasonRequired: true, bookingReasons: [],
});
declare global {
  interface Window {
    bookingMode?: 'pending' | 'success';
    submittedDraft?: Parameters<typeof api.createBulkBookings>[1];
    finishBooking?: () => void;
  }
}
api.createBulkBookings = async (_groupId, draft) => {
  window.submittedDraft = structuredClone(draft);
  if (window.bookingMode === 'pending') await new Promise<void>((resolve) => { window.finishBooking = resolve; });
  if (window.bookingMode) return [];
  throw new Error('Controlled server error');
};
window.history.replaceState({}, '', `/book?group=${group.id}&product=product-water&scan=1`);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ActiveGroupContext.Provider value={{ activeGroupId: group.id, activeGroup: group, session, setActiveGroupId: () => {} }}>
      <BookingPage />
    </ActiveGroupContext.Provider>
  </QueryClientProvider>,
);
