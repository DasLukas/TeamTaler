import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, ActivityFilterOptions, CollectionPage, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { ActivitiesPage } from './ActivitiesPage';

const apiMock = vi.hoisted(() => ({
  getActivitiesPage: vi.fn(),
  getActivityFilterOptions: vi.fn(),
  getPaymentAttachment: vi.fn(),
  reverseBooking: vi.fn(),
  reversePayment: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-viewer', displayName: 'Viewer', email: 'viewer@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-viewer', roles: ['MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  systemRoles: [],
};

const booking: ActivityEntry = {
  id: 'BOOKING:booking-a',
  sourceId: 'booking-a',
  kind: 'BOOKING',
  targetMembershipId: 'member-target',
  targetDisplayName: 'Target Member',
  targetMembershipStatus: 'ACTIVE',
  targetAvatarUrl: '/avatars/target.png',
  actorMembershipId: 'member-manager',
  actorDisplayName: 'Assigning Manager',
  actorMembershipStatus: 'ACTIVE',
  actorAvatarUrl: '/avatars/manager.png',
  detailName: 'Late arrival',
  categoryId: 'category-penalties',
  categoryName: 'Penalties',
  productId: 'product-penalty',
  quantity: 1,
  amount: { minorUnits: '500', currency: 'EUR' },
  occurredAt: '2026-08-04T12:00:00Z',
  status: 'POSTED',
  canReverse: false,
  reversalReasonRequired: false,
};

const payment: ActivityEntry = {
  id: 'PAYMENT:payment-a',
  sourceId: 'payment-a',
  kind: 'PAYMENT',
  targetMembershipId: 'member-target',
  targetDisplayName: 'Target Member',
  targetMembershipStatus: 'ACTIVE',
  targetAvatarUrl: '/avatars/target.png',
  actorMembershipId: 'member-manager',
  actorDisplayName: 'Assigning Manager',
  actorMembershipStatus: 'ACTIVE',
  actorAvatarUrl: '/avatars/manager.png',
  detailName: 'Bank transfer',
  detailNote: 'August',
  amount: { minorUnits: '-2000', currency: 'EUR' },
  occurredAt: '2026-08-04T13:00:00Z',
  status: 'POSTED',
  attachment: { fileName: 'receipt.jpg', mediaType: 'image/jpeg', sizeBytes: 1200, url: '/receipt' },
  canReverse: true,
  reversalReasonRequired: true,
};

const adjustment: ActivityEntry = {
  id: 'ADJUSTMENT:ledger-a',
  sourceId: 'ledger-a',
  kind: 'ADJUSTMENT',
  targetMembershipId: 'member-target',
  targetDisplayName: 'Target Member',
  targetMembershipStatus: 'ACTIVE',
  detailName: 'Manual correction',
  amount: { minorUnits: '-150', currency: 'EUR' },
  occurredAt: '2026-08-04T14:00:00Z',
  status: 'POSTED',
  canReverse: false,
  reversalReasonRequired: false,
};

const filterOptions: ActivityFilterOptions = {
  members: [{ membershipId: 'member-target', displayName: 'Target Member', avatarUrl: '/avatars/target.png' }],
  categories: [{ categoryId: 'category-penalties', name: 'Penalties', icon: 'penalty' }],
  products: [{ productId: 'product-penalty', categoryId: 'category-penalties', name: 'Late arrival', imageUrl: '/images/late-arrival.png' }],
};

function activityPage(items: ActivityEntry[], nextCursor?: string): CollectionPage<ActivityEntry> {
  return { hasMore: Boolean(nextCursor), items, limit: 50, nextCursor };
}

function renderActivities(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<ActivitiesPage />, { wrapper });
  return queryClient;
}

describe('ActivitiesPage unified feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/activities');
    apiMock.getActivityFilterOptions.mockResolvedValue(filterOptions);
    apiMock.getActivitiesPage.mockResolvedValue(activityPage([adjustment, payment, booking]));
    apiMock.getPaymentAttachment.mockResolvedValue(new Blob(['receipt'], { type: 'image/jpeg' }));
    apiMock.reverseBooking.mockResolvedValue(undefined);
    apiMock.reversePayment.mockResolvedValue(undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:receipt');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  it('renders bookings, payments, and corrections from one semantic feed', async () => {
    renderActivities();

    const table = await screen.findByRole('table', { name: i18n.t('activities.title') });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(within(table).getByRole('img', { name: i18n.t('activities.bookingType') })).toBeVisible();
    expect(within(table).getByRole('img', { name: i18n.t('activities.paymentType') })).toBeVisible();
    expect(within(table).getByRole('img', { name: i18n.t('activities.adjustmentType') })).toBeVisible();
    expect(within(table).getByText(/\+5,00/)).toBeVisible();
    expect(within(table).getByText(/-20,00/)).toBeVisible();
    expect(within(table).getByLabelText(i18n.t('activities.actorUnavailable'))).toBeVisible();
    expect(apiMock.getActivitiesPage).toHaveBeenCalledWith('group-a', expect.objectContaining({ limit: 50, sort: 'occurredAt', direction: 'desc' }));
  });

  it('refetches feed-derived filter options through the shared activity cache prefix', async () => {
    const queryClient = renderActivities();
    await waitFor(() => expect(apiMock.getActivityFilterOptions).toHaveBeenCalledTimes(1));

    await queryClient.invalidateQueries({ queryKey: ['activities', 'group-a'] });

    await waitFor(() => expect(apiMock.getActivityFilterOptions).toHaveBeenCalledTimes(2));
  });

  it('sends member, repeated type, category, and product filters to the unified endpoint', async () => {
    const user = userEvent.setup();
    renderActivities();
    await screen.findByRole('table', { name: i18n.t('activities.title') });

    await user.click(screen.getByRole('button', { name: i18n.t('dataTable.filterButton') }));
    const filterDialog = screen.getByRole('dialog', { name: i18n.t('dataTable.filterHeading') });
    await user.click(within(filterDialog).getByRole('combobox', { name: i18n.t('common.member') }));
    await user.click(within(screen.getByRole('listbox', { name: i18n.t('common.member') })).getByRole('option', { name: 'Target Member' }));
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('activities.transaction') }));
    const kindMenu = screen.getByRole('dialog', { name: i18n.t('activities.transaction') });
    await user.click(within(kindMenu).getByRole('checkbox', { name: i18n.t('activities.paymentType') }));
    await user.click(within(kindMenu).getByRole('checkbox', { name: i18n.t('activities.adjustmentType') }));
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('common.category') }));
    await user.click(within(screen.getByRole('dialog', { name: i18n.t('common.category') })).getByRole('checkbox', { name: 'Penalties' }));
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('common.product') }));
    await user.click(within(screen.getByRole('dialog', { name: i18n.t('common.product') })).getByRole('checkbox', { name: 'Late arrival' }));
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('dataTable.applyFilters') }));

    await waitFor(() => expect(apiMock.getActivitiesPage).toHaveBeenLastCalledWith('group-a', expect.objectContaining({
      categoryId: ['category-penalties'],
      kind: ['PAYMENT', 'ADJUSTMENT'],
      productId: ['product-penalty'],
      targetMembershipId: 'member-target',
    })));
  });

  it('loads every server page without truncating a full first source page', async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ ...booking, id: `BOOKING:${index}`, sourceId: `booking-${index}`, detailName: `Booking ${index}` }));
    apiMock.getActivitiesPage.mockImplementation((_groupId: string, query: { cursor?: string }) => Promise.resolve(
      query.cursor ? activityPage([payment]) : activityPage(firstPage, 'cursor-2'),
    ));
    renderActivities();

    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(51));
    await user.click(screen.getByRole('button', { name: i18n.t('dataTable.loadMore') }));
    await screen.findByRole('row', { name: /Einzahlung.*Target Member/ });
    expect(screen.getAllByRole('row')).toHaveLength(52);
    expect(apiMock.getActivitiesPage).toHaveBeenLastCalledWith('group-a', expect.objectContaining({ cursor: 'cursor-2' }));
  });

  it('opens protected payment receipts and uses payment reversal metadata', async () => {
    const user = userEvent.setup();
    renderActivities();
    const paymentRow = await screen.findByRole('row', { name: /Einzahlung.*Target Member/ });

    await user.click(within(paymentRow).getByRole('button', { name: i18n.t('paymentAttachment.action') }));
    expect(await screen.findByRole('dialog', { name: 'receipt.jpg' })).toBeVisible();
    expect(apiMock.getPaymentAttachment).toHaveBeenCalledWith('group-a', 'payment-a');
    await user.click(within(paymentRow).getByRole('button', { name: i18n.t('activities.reverse') }));
    expect(screen.getByRole('heading', { name: i18n.t('finance.reverseTitle') })).toBeVisible();
    const reason = screen.getByLabelText(i18n.t('finance.reason'));
    await user.type(reason, 'Duplicate payment');
    await user.click(screen.getByRole('button', { name: i18n.t('finance.confirmReverse') }));
    await waitFor(() => expect(apiMock.reversePayment).toHaveBeenCalledWith('group-a', 'payment-a', 'Duplicate payment'));
  });

  it('uses booking-specific action metadata and preserves reversed originals', async () => {
    const user = userEvent.setup();
    apiMock.getActivitiesPage.mockResolvedValue(activityPage([{ ...booking, status: 'REVERSED' }, {
      ...booking,
      id: 'BOOKING:reversible',
      sourceId: 'reversible',
      detailName: 'Reversible booking',
      canReverse: true,
      reversalReasonRequired: false,
      reversalWithoutReasonUntil: '2026-08-07T12:00:30Z',
    }]));
    renderActivities();

    expect(await screen.findByRole('img', { name: i18n.t('common.reversed') })).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('activities.reverse') }));
    expect(screen.getByLabelText(i18n.t('finance.reason'))).not.toBeRequired();
    await user.click(screen.getByRole('button', { name: i18n.t('activities.confirmReverse') }));
    await waitFor(() => expect(apiMock.reverseBooking).toHaveBeenCalledWith('group-a', 'reversible', ''));
  });

  it('shows loading and request failures in the table', async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    apiMock.getActivitiesPage.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    renderActivities();
    expect(screen.getByText(i18n.t('common.loading'))).toBeVisible();

    rejectRequest?.(new Error('network failed'));
    expect(await screen.findByText(i18n.t('activities.error'))).toBeVisible();
  });
});
