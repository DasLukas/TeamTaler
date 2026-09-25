import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BookingPermissionRoute } from './PermissionRoutes';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));
vi.mock('./useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@/features/bookings/BookingPage', () => ({ BookingPage: () => <p>Booking workspace</p> }));

describe('booking QR group access', () => {
  afterEach(() => window.history.replaceState({}, '', '/book'));

  it('does not show a different active group for a foreign group poster QR', () => {
    window.history.replaceState({}, '', '/book?group=foreign-group');
    const group = { id: 'group-a', membership: { effectiveGrants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }] } };
    mocks.useActiveGroup.mockReturnValue({ activeGroup: group, session: { groups: [group] } });
    render(<BookingPermissionRoute />);
    expect(screen.getByText(i18n.t('kiosk.groupUnavailable'))).toBeVisible();
    expect(screen.queryByText('Booking workspace')).not.toBeInTheDocument();
  });

  it('waits for the requested group before evaluating booking permission', () => {
    window.history.replaceState({}, '', '/book?group=group-b');
    const groupA = { id: 'group-a', membership: { effectiveGrants: [] } };
    const groupB = { id: 'group-b', membership: { effectiveGrants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }] } };
    mocks.useActiveGroup.mockReturnValue({ activeGroup: groupA, session: { groups: [groupA, groupB] } });
    render(<BookingPermissionRoute />);
    expect(screen.getByText(i18n.t('state.loadingTitle'))).toBeVisible();
    expect(screen.queryByText(i18n.t('booking.noAccessMessage'))).not.toBeInTheDocument();
  });
});
