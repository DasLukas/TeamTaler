import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingContext, GroupRole } from '@/api/types';
import { demoCategories, demoDashboard, demoMembers, demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { BookingPage } from './BookingPage';

const mocks = vi.hoisted(() => ({
  getBookingContext: vi.fn(),
  getCategories: vi.fn(),
  createBulkBookings: vi.fn(),
  useMediaQuery: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getBookingContext: mocks.getBookingContext,
    getCategories: mocks.getCategories,
    createBulkBookings: mocks.createBulkBookings,
  },
}));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => mocks.useMediaQuery() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

function bookingContext(targets = demoMembers.slice(0, 3)): BookingContext {
  return {
    openPeriod: demoDashboard.currentPeriod,
    ownBalance: demoDashboard.openBalance,
    currentMembership: demoMembers[0],
    targets: targets.map((member) => ({ membershipId: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl, isTemporaryGuest: member.isTemporaryGuest })),
    canBookForGuests: false,
    foreignBookingReasonRequired: true,
    bookingReasons: [],
  };
}

function renderBookingPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><BookingPage /></QueryClientProvider>);
}

function recipientButtonLabel(count: number): string {
  return i18n.t('booking.targetButtonLabel', { count });
}

describe('BookingPage multi-product workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCategories.mockResolvedValue(demoCategories);
    mocks.getBookingContext.mockResolvedValue(bookingContext());
    mocks.createBulkBookings.mockResolvedValue([{ id: 'booking-created' }]);
    mocks.useMediaQuery.mockReturnValue(false);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, activeGroup: demoSession.groups[0], session: demoSession });
  });

  it('completes the common fixed-price self booking with product tap and visible confirmation', async () => {
    const user = userEvent.setup();
    mocks.getBookingContext.mockResolvedValue(bookingContext([demoMembers[0]]));
    renderBookingPage();

    const water = await screen.findByRole('button', { name: /Wasser.*1,00.*hinzufügen/i });
    expect(screen.queryByRole('button', { name: recipientButtonLabel(1) })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('booking.submit') })).not.toBeInTheDocument();

    await user.click(water);
    const submit = screen.getByRole('button', { name: i18n.t('booking.submit') });
    expect(submit).toBeVisible();
    await user.click(submit);

    await waitFor(() => expect(mocks.createBulkBookings).toHaveBeenCalledWith(demoSession.activeGroupId, {
      expectedPeriodId: demoDashboard.currentPeriod.id,
      items: [{ productId: 'product-water', productVersion: 1, quantity: 1, unitPrice: undefined }],
      targetMembershipIds: [demoMembers[0].id],
      reason: undefined,
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(i18n.t('booking.bulkSuccess', { count: 1 }));
    expect(screen.queryByRole('button', { name: i18n.t('booking.submit') })).not.toBeInTheDocument();
  });

  it('decreases and removes a selected product directly from its catalogue card', async () => {
    const user = userEvent.setup();
    renderBookingPage();

    const water = await screen.findByRole('button', { name: /Wasser.*1,00.*hinzufügen/i });
    await user.click(water);
    await user.click(water);
    const catalogue = screen.getByRole('tabpanel');
    await user.click(within(catalogue).getByRole('button', { name: i18n.t('booking.decreaseProductQuantity', { name: 'Wasser' }) }));
    expect(screen.getByRole('button', { name: /Wasser.*Aktuell 1/i })).toBeVisible();

    await user.click(within(catalogue).getByRole('button', { name: i18n.t('booking.removeProduct', { name: 'Wasser' }) }));
    expect(screen.getByRole('button', { name: /Wasser.*Aktuell 0/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('booking.submit') })).not.toBeInTheDocument();
  });

  it('submits ordered product lines and targets once with a shared foreign-booking reason', async () => {
    const user = userEvent.setup();
    mocks.createBulkBookings.mockResolvedValue([{ id: 'one' }, { id: 'two' }, { id: 'three' }, { id: 'four' }]);
    renderBookingPage();

    await user.click(await screen.findByRole('button', { name: recipientButtonLabel(1) }));
    await user.click(screen.getByRole('checkbox', { name: new RegExp(demoMembers[1].displayName) }));
    await user.click(screen.getByRole('button', { name: /Wasser.*1,00.*hinzufügen/i }));
    await user.click(screen.getByRole('button', { name: /Wasser.*1,00.*Aktuell 1/i }));
    await user.click(screen.getByRole('tab', { name: 'Strafen' }));
    await user.click(screen.getByRole('button', { name: /Zu spät zum Training.*5,00.*hinzufügen/i }));
    await user.type(screen.getByLabelText(`${i18n.t('booking.reason')} *`), 'Teamabend');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.submitBookingCount', { count: 4 }) }));

    await waitFor(() => expect(mocks.createBulkBookings).toHaveBeenCalledTimes(1));
    expect(mocks.createBulkBookings).toHaveBeenCalledWith(demoSession.activeGroupId, {
      expectedPeriodId: demoDashboard.currentPeriod.id,
      items: [
        { productId: 'product-water', productVersion: 1, quantity: 2, unitPrice: undefined },
        { productId: 'product-late', productVersion: 1, quantity: 1, unitPrice: undefined },
      ],
      targetMembershipIds: [demoMembers[0].id, demoMembers[1].id],
      reason: 'Teamabend',
    });
    expect(screen.getByRole('status')).toHaveTextContent(i18n.t('booking.bulkSuccess', { count: 4 }));
    expect(screen.getByRole('button', { name: recipientButtonLabel(1) })).toHaveTextContent('1');
  });

  it('keeps the recipient control compact and omits redundant context copy', async () => {
    renderBookingPage();

    expect(await screen.findByText(i18n.t('booking.openBalance'))).toBeVisible();
    const recipientButton = screen.getByRole('button', { name: recipientButtonLabel(1) });
    expect(recipientButton).toHaveTextContent('1');
    expect(recipientButton).not.toHaveTextContent(demoMembers[0].displayName);
    expect(screen.queryByText('Empfänger-Kontext')).not.toBeInTheDocument();
    expect(screen.queryByText(/Alle Produkte im Warenkorb werden für/)).not.toBeInTheDocument();
  });

  it('clears a hidden reason when the last credentialed foreign target is removed', async () => {
    const user = userEvent.setup();
    renderBookingPage();

    await user.click(await screen.findByRole('button', { name: recipientButtonLabel(1) }));
    await user.click(screen.getByRole('checkbox', { name: new RegExp(demoMembers[1].displayName) }));
    await user.click(screen.getByRole('button', { name: /Wasser.*1,00.*hinzufügen/i }));
    await user.type(screen.getByLabelText(`${i18n.t('booking.reason')} *`), 'Old reason');
    await user.click(screen.getByRole('button', { name: recipientButtonLabel(2) }));
    const foreignTarget = screen.getByRole('checkbox', { name: new RegExp(demoMembers[1].displayName) });
    await user.click(foreignTarget);
    expect(screen.queryByLabelText(`${i18n.t('booking.reason')} *`)).not.toBeInTheDocument();
    await user.click(foreignTarget);
    expect(screen.getByLabelText(`${i18n.t('booking.reason')} *`)).toHaveValue('');
  });

  it('keeps the required reason in the compact checkout without expanding cart details', async () => {
    const user = userEvent.setup();
    mocks.useMediaQuery.mockReturnValue(true);
    renderBookingPage();

    await user.click(await screen.findByRole('button', { name: recipientButtonLabel(1) }));
    await user.click(screen.getByRole('checkbox', { name: new RegExp(demoMembers[1].displayName) }));
    await user.click(screen.getByRole('button', { name: recipientButtonLabel(2) }));
    await user.click(screen.getByRole('button', { name: /Wasser.*1,00.*hinzufügen/i }));

    const reasonInput = screen.getByLabelText(`${i18n.t('booking.reason')} *`);
    const submit = screen.getByRole('button', { name: i18n.t('booking.submitBookingCount', { count: 2 }) });
    expect(reasonInput).toBeVisible();
    expect(submit).toBeDisabled();
    expect(screen.getByRole('button', { name: i18n.t('booking.cartEdit') })).toHaveAttribute('aria-expanded', 'false');

    await user.type(reasonInput, 'Teamabend');
    expect(submit).toBeEnabled();
  });

  it('shows the catalogue empty state only when no bookable products exist', async () => {
    mocks.getCategories.mockResolvedValue([]);
    renderBookingPage();

    expect(await screen.findByText(i18n.t('booking.noProductsTitle'))).toBeVisible();
    expect(screen.getByRole('link', { name: i18n.t('booking.catalogLink') })).toHaveAttribute('href', '/catalog');
  });

  it('does not expose catalog navigation without catalog rights', async () => {
    const groups = demoSession.groups.map((group) => group.id === demoSession.activeGroupId
      ? { ...group, membership: group.membership ? { ...group.membership, roles: ['MEMBER'] as GroupRole[], effectiveGrants: [] } : undefined }
      : group);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, activeGroup: groups[0], session: { ...demoSession, groups } });
    mocks.getCategories.mockResolvedValue([]);
    renderBookingPage();

    expect(await screen.findByText(i18n.t('booking.noProductsTitle'))).toBeVisible();
    expect(screen.queryByRole('link', { name: i18n.t('booking.catalogLink') })).not.toBeInTheDocument();
  });
});
