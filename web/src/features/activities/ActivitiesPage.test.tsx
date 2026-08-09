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
  getBookings: vi.fn(),
  getCategories: vi.fn(),
  reverseBooking: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-viewer', displayName: 'Viewer', email: 'viewer@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-viewer', roles: ['MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
};

const thirdPartyBooking: Booking = {
  id: 'booking-third-party',
  memberId: 'member-target',
  memberName: 'Target Member',
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
  bookedByMemberId: 'member-manager',
  bookedByAvatarUrl: '/avatars/manager.png',
  status: 'POSTED',
  canVoid: false,
};

function renderActivities(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<ActivitiesPage />, { wrapper });
}

describe('ActivitiesPage booking traceability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.reverseBooking.mockResolvedValue(undefined);
    apiMock.getBookings.mockResolvedValue([thirdPartyBooking]);
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

    const row = await screen.findByRole('row', { name: /Target Member.*Assigning Manager/ });
    expect(within(row).getByText(thirdPartyBooking.memberName)).toBeVisible();
    expect(within(row).getByText(thirdPartyBooking.bookedByName)).toBeVisible();
    await waitFor(() => expect(row.querySelector('img[src="/api/v1/groups/group-a/images/late-arrival.png"]')).toBeInTheDocument());
    expect(row.querySelector('img[src="/avatars/target.png"]')).toHaveAttribute('alt', '');
    expect(row.querySelector('img[src="/avatars/manager.png"]')).toHaveAttribute('alt', '');
    expect(screen.getByRole('columnheader', { name: i18n.t('activities.bookedFor') })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: i18n.t('activities.bookedBy') })).toBeVisible();
    expect(within(row).getByRole('cell', { name: /Target Member/ })).toHaveAttribute('data-label', i18n.t('activities.bookedFor'));
    expect(within(row).getByRole('cell', { name: /Assigning Manager/ })).toHaveAttribute('data-label', i18n.t('activities.bookedBy'));
    expect(within(row).getByRole('cell', { name: thirdPartyBooking.productName })).toHaveAttribute('data-label', i18n.t('activities.booking'));

    await user.type(screen.getByLabelText(i18n.t('activities.searchLabel')), thirdPartyBooking.bookedByName);
    expect(await screen.findByRole('row', { name: /Target Member.*Assigning Manager/ })).toBeVisible();
  });

  it('allows a self-created booking inside the server-provided window without a reason', async () => {
    const user = userEvent.setup();
    apiMock.getBookings.mockResolvedValue([{
      ...thirdPartyBooking,
      id: 'booking-self-created',
      memberId: 'member-viewer',
      memberName: 'Viewer',
      bookedByMemberId: 'member-viewer',
      bookedByName: 'Viewer',
      canVoid: true,
      voidReasonRequired: false,
      voidWithoutReasonUntil: '2026-08-07T12:00:30Z',
    }]);
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
    apiMock.getBookings.mockResolvedValue([{
      ...thirdPartyBooking,
      memberId: 'member-viewer',
      memberName: 'Viewer',
      canVoid: true,
      voidReasonRequired: true,
      voidWithoutReasonUntil: undefined,
    }]);
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
});
