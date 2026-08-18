import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { ActivitiesPage } from './ActivitiesPage';

const apiMock = vi.hoisted(() => ({
  getBookingsPage: vi.fn(),
  getCategories: vi.fn(),
  reverseBooking: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-viewer', displayName: 'Viewer', email: 'viewer@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-viewer', roles: ['MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  systemRoles: [],
};

const thirdPartyBooking: Booking = {
  id: 'booking-third-party',
  memberId: 'member-target',
  memberName: 'Target Member',
  memberStatus: 'ACTIVE',
  memberAvatarUrl: '/avatars/target.png',
  productId: 'product-penalty',
  productName: 'Late arrival',
  categoryId: 'category-penalties',
  categoryName: 'Penalties',
  quantity: 1,
  unitPrice: { minorUnits: '500', currency: 'EUR' },
  total: { minorUnits: '500', currency: 'EUR' },
  bookedAt: '2026-08-04T12:00:00Z',
  bookedByName: 'Assigning Manager',
  bookedByStatus: 'ACTIVE',
  bookedByMemberId: 'member-manager',
  bookedByAvatarUrl: '/avatars/manager.png',
  status: 'POSTED',
  canVoid: false,
};

const bookingPage = (items: Booking[]) => ({ hasMore: false, items, limit: 50 });

function renderActivities(sessionValue: Session = session): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session: sessionValue, activeGroup: sessionValue.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<ActivitiesPage />, { wrapper });
}

describe('ActivitiesPage booking traceability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/activities');
    apiMock.reverseBooking.mockResolvedValue(undefined);
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([thirdPartyBooking]));
    apiMock.getCategories.mockResolvedValue([{
      id: thirdPartyBooking.categoryId,
      version: 1,
      name: thirdPartyBooking.categoryName,
      icon: 'penalty',
      active: true,
      sortOrder: 1,
      products: [{
        id: thirdPartyBooking.productId,
        categoryId: thirdPartyBooking.categoryId,
        version: 1,
        name: thirdPartyBooking.productName,
        pricingMode: 'FIXED',
        currency: 'EUR',
        price: thirdPartyBooking.unitPrice,
        imageUrl: '/api/v1/groups/group-a/images/late-arrival.png',
        active: true,
        sortOrder: 1,
      }],
    }]);
  });

  it('shows target and actor distinctly and includes the actor in search', async () => {
    const user = userEvent.setup();
    renderActivities();

    const heading = await screen.findByRole('heading', { level: 1, name: i18n.t('activities.title') });
    expect(heading.parentElement?.querySelector('p')).not.toBeInTheDocument();
    const row = await screen.findByRole('row', { name: /Target Member.*Assigning Manager/ });
    expect(within(row).getByText(thirdPartyBooking.memberName)).toBeVisible();
    expect(within(row).getByText(thirdPartyBooking.bookedByName)).toBeVisible();
    await waitFor(() => expect(row.querySelector('img[src="/api/v1/groups/group-a/images/late-arrival.png"]')).toBeInTheDocument());
    expect(row.querySelector('img[src="/avatars/target.png"]')).toHaveAttribute('alt', '');
    expect(row.querySelector('img[src="/avatars/manager.png"]')).toHaveAttribute('alt', '');
    expect(screen.getByRole('columnheader', { name: new RegExp(i18n.t('activities.bookedFor')) })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: new RegExp(i18n.t('activities.bookedBy')) })).toBeVisible();
    expect(within(row).getByRole('cell', { name: /Target Member/ })).toBeVisible();
    expect(within(row).getByRole('cell', { name: /Assigning Manager/ })).toBeVisible();
    expect(within(row).getByRole('cell', { name: thirdPartyBooking.productName })).toBeVisible();
    expect(row.querySelector('time')).toHaveAttribute('datetime', thirdPartyBooking.bookedAt);
    expect(within(row).getByRole('img', { name: i18n.t('common.booked') })).toHaveAttribute('title', i18n.t('common.booked'));

    await user.type(screen.getByLabelText(i18n.t('activities.searchLabel')), thirdPartyBooking.bookedByName);
    expect(await screen.findByRole('row', { name: /Target Member.*Assigning Manager/ })).toBeVisible();
    await waitFor(() => expect(apiMock.getBookingsPage).toHaveBeenLastCalledWith(
      'group-a',
      expect.objectContaining({ q: thirdPartyBooking.bookedByName }),
    ));
  });

  it('preserves activities as a semantic table with vertical booking rows', async () => {
    renderActivities();

    const table = await screen.findByRole('table', { name: i18n.t('activities.title') });
    await within(table).findByRole('row', { name: /Target Member.*Assigning Manager/ });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(8);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getAllByRole('cell')).toHaveLength(8);
  });

  it('renders reversed bookings as accessible compact status badges', async () => {
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([{ ...thirdPartyBooking, status: 'REVERSED' }]));
    renderActivities();

    const row = await screen.findByRole('row', { name: /Target Member.*Assigning Manager/ });
    expect(within(row).getByRole('img', { name: i18n.t('common.reversed') })).toHaveAttribute('title', i18n.t('common.reversed'));
  });

  it('uses the current session avatar when stale booking data omits it', async () => {
    const avatarUrl = '/avatars/current-user.png';
    const selfBooking: Booking = {
      ...thirdPartyBooking,
      memberId: 'member-viewer',
      memberName: 'Viewer',
      memberAvatarUrl: undefined,
      bookedByMemberId: 'member-viewer',
      bookedByName: 'Viewer',
      bookedByAvatarUrl: undefined,
    };
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([selfBooking]));
    renderActivities({ ...session, user: { ...session.user, avatarUrl } });

    const row = await screen.findByRole('row', { name: /Viewer.*Viewer/ });
    expect(row.querySelectorAll(`img[src="${avatarUrl}"]`)).toHaveLength(2);
  });

  it('allows a self-created booking inside the server-provided window without a reason', async () => {
    const user = userEvent.setup();
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([{
      ...thirdPartyBooking,
      id: 'booking-self-created',
      memberId: 'member-viewer',
      memberName: 'Viewer',
      bookedByMemberId: 'member-viewer',
      bookedByName: 'Viewer',
      canVoid: true,
      voidReasonRequired: false,
      voidWithoutReasonUntil: '2026-08-07T12:00:30Z',
    }]));
    renderActivities();

    await user.click(await screen.findByRole('button', { name: i18n.t('activities.reverse') }));
    const reason = screen.getByLabelText(i18n.t('finance.reason'));
    expect(reason).not.toBeRequired();
    expect(screen.getByText(/ohne Begründung/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('activities.confirmReverse') }));

    await waitFor(() => expect(apiMock.reverseBooking).toHaveBeenCalledWith('group-a', 'booking-self-created', ''));
  });

  it('always requires a reason for a received booking created by another member', async () => {
    const user = userEvent.setup();
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([{
      ...thirdPartyBooking,
      memberId: 'member-viewer',
      memberName: 'Viewer',
      canVoid: true,
      voidReasonRequired: true,
      voidWithoutReasonUntil: undefined,
    }]));
    renderActivities();

    await user.click(await screen.findByRole('button', { name: i18n.t('activities.reverse') }));
    const reason = screen.getByLabelText(i18n.t('finance.reason'));
    const submit = screen.getByRole('button', { name: i18n.t('activities.confirmReverse') });
    expect(reason).toBeRequired();
    expect(submit).toBeDisabled();
    await user.type(reason, 'Incorrect assignment');
    await user.click(submit);

    await waitFor(() => expect(apiMock.reverseBooking).toHaveBeenCalledWith('group-a', thirdPartyBooking.id, 'Incorrect assignment'));
  });

  it('marks deleted historical actors and targets without exposing prior avatars', async () => {
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([{
      ...thirdPartyBooking,
      memberStatus: 'DELETED',
      memberAvatarUrl: undefined,
      bookedByStatus: 'DELETED',
      bookedByAvatarUrl: undefined,
    }]));
    renderActivities();

    const row = await screen.findByRole('row', { name: /Target Member.*Gelöscht.*Assigning Manager.*Gelöscht/ });
    const deletedMarkers = within(row).getAllByRole('img', { name: i18n.t('common.deleted') });
    expect(deletedMarkers).toHaveLength(2);
    expect(deletedMarkers[0]).toHaveAttribute('title', i18n.t('common.deleted'));
    expect(row.querySelector('img[src="/avatars/target.png"]')).not.toBeInTheDocument();
    expect(row.querySelector('img[src="/avatars/manager.png"]')).not.toBeInTheDocument();
  });

  it('marks archived historical actors and targets with accessible tooltips', async () => {
    apiMock.getBookingsPage.mockResolvedValue(bookingPage([{
      ...thirdPartyBooking,
      memberStatus: 'ARCHIVED',
      bookedByStatus: 'ARCHIVED',
    }]));
    renderActivities();

    const row = await screen.findByRole('row', { name: /Target Member.*Archiviert.*Assigning Manager.*Archiviert/ });
    const archivedMarkers = within(row).getAllByRole('img', { name: i18n.t('common.archived') });
    expect(archivedMarkers).toHaveLength(2);
    expect(archivedMarkers[0]).toHaveAttribute('title', i18n.t('common.archived'));
  });
});
