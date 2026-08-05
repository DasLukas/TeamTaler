import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRole } from '@/api/types';
import { demoCategories, demoDashboard, demoMembers, demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { BookingPage } from './BookingPage';

const mocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getCategories: vi.fn(),
  getMembers: vi.fn(),
  createBooking: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getDashboard: mocks.getDashboard,
    getCategories: mocks.getCategories,
    getMembers: mocks.getMembers,
    createBooking: mocks.createBooking,
  },
}));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

function renderBookingPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><BookingPage /></QueryClientProvider>);
}

describe('BookingPage explicit product selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboard.mockResolvedValue(demoDashboard);
    mocks.getCategories.mockResolvedValue(demoCategories);
    mocks.getMembers.mockResolvedValue(demoMembers);
    mocks.createBooking.mockResolvedValue({ id: 'booking-created' });
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, session: demoSession });
  });

  it('starts neutral and completes a fixed-price self-booking in two deliberate interactions', async () => {
    const user = userEvent.setup();
    renderBookingPage();

    const water = await screen.findByRole('button', { name: /Wasser.*1,00/i });
    expect(water).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(water);
    expect(await screen.findByRole('dialog')).toHaveAccessibleName(i18n.t('booking.productTitle', { name: 'Wasser' }));
    await user.click(screen.getByRole('button', { name: i18n.t('booking.submit') }));

    await waitFor(() => expect(mocks.createBooking).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 2_000 });
    expect(water).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears selection when changing categories or cancelling', async () => {
    const user = userEvent.setup();
    renderBookingPage();

    await user.click(await screen.findByRole('tab', { name: 'Strafen' }));
    const penalty = screen.getByRole('button', { name: /Zu spät zum Training.*5,00/i });
    expect(penalty).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(penalty);
    expect(await screen.findByRole('dialog')).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(penalty).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the catalogue empty state only when no bookable products exist', async () => {
    mocks.getCategories.mockResolvedValue([]);
    renderBookingPage();

    expect(await screen.findByText(i18n.t('booking.noProductsTitle'))).toBeVisible();
    expect(screen.getByRole('link', { name: i18n.t('booking.catalogLink') })).toHaveAttribute('href', '/catalog');
    expect(screen.queryByText(i18n.t('booking.quickTitle'))).not.toBeInTheDocument();
  });

  it('does not expose catalog navigation without catalog rights', async () => {
    const groups = demoSession.groups.map((group) => group.id === demoSession.activeGroupId
      ? { ...group, membership: group.membership ? { ...group.membership, roles: ['MEMBER'] as GroupRole[] } : undefined }
      : group);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, session: { ...demoSession, groups } });
    mocks.getCategories.mockResolvedValue([]);
    renderBookingPage();

    expect(await screen.findByText(i18n.t('booking.noProductsTitle'))).toBeVisible();
    expect(screen.queryByRole('link', { name: i18n.t('booking.catalogLink') })).not.toBeInTheDocument();
  });
});
