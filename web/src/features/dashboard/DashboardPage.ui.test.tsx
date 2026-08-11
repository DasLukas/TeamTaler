import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRole } from '@/api/types';
import { demoDashboard, demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { DashboardPage } from './DashboardPage';

const mocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getTransactionSettings: vi.fn(),
  getCategories: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getDashboard: mocks.getDashboard,
    getTransactionSettings: mocks.getTransactionSettings,
    getCategories: mocks.getCategories,
    createOwnPayment: vi.fn(),
  },
}));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

describe('DashboardPage information-only overview', () => {
  const transactionSettings = {
    settlementsEnabled: true,
    foreignBookingReasonRequired: true,
    ownPaymentReasonRequired: true,
    otherPaymentReasonRequired: false,
    paymentMethods: [{ id: 'CASH', label: 'Bar' }],
    bookingReasons: [],
    paymentReasons: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboard.mockResolvedValue(demoDashboard);
    mocks.getTransactionSettings.mockResolvedValue(transactionSettings);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, activeGroup: demoSession.groups[0], session: demoSession });
  });

  it('keeps all information blocks without loading or rendering booking controls', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('dashboard.recentActivities'))).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Lukas');
    expect(screen.getAllByText(/23,40/).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('dashboard.settlement', { label: 'August' }))).toBeVisible();
    const periodHeading = screen.getByRole('heading', { name: demoDashboard.currentPeriod.label });
    expect(periodHeading).toBeVisible();
    expect(periodHeading.parentElement).toBeInstanceOf(HTMLElement);
    expect(periodHeading.nextElementSibling?.tagName).toBe('DIV');
    expect(screen.getByText(i18n.t('dashboard.paymentNoteSelf'))).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.allActivities'))).toBeVisible();
    const groupStatisticsHeading = screen.getByRole('heading', { name: i18n.t('dashboard.groupStatistics.title') });
    expect(groupStatisticsHeading).toBeVisible();
    expect(groupStatisticsHeading.parentElement?.querySelector('p')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('dashboard.groupStatistics.bookingCount', { count: 42 }))).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.groupStatistics.bookingCount', { count: 6 }))).toBeVisible();
    expect(screen.getByRole('img', { name: i18n.t('dashboard.groupStatistics.percentageLabel', { category: 'Getränke', percentage: 100 }) })).toBeVisible();
    expect(screen.queryByText(i18n.t('booking.quickTitle'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('booking.submit') })).not.toBeInTheDocument();
    expect(mocks.getCategories).not.toHaveBeenCalled();
  });

  it('hides the self-payment action when the active membership has no effective permission', async () => {
    const activeGroup = {
      ...demoSession.groups[0],
      membership: { id: 'member-regular', roles: ['MEMBER'] as GroupRole[], groupPermissions: [] },
    };
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: activeGroup.id, activeGroup, session: { ...demoSession, groups: [activeGroup] } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('dashboard.paymentNote'))).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('selfPayment.action') })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: i18n.t('dashboard.groupStatistics.title') })).not.toBeInTheDocument();
  });

  it('marks a negative open balance as credit in the member\'s favor', async () => {
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, openBalance: { minorUnits: '-250', currency: 'EUR' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(/-2,50/, { selector: 'strong[data-financial-state="credit"]' })).toBeVisible();
  });

  it('removes period references and uses all-time labels when settlements are disabled', async () => {
    mocks.getTransactionSettings.mockResolvedValue({ ...transactionSettings, settlementsEnabled: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: i18n.t('dashboard.bookingsByCategory') })).toBeVisible();
    expect(screen.queryByText(i18n.t('dashboard.settlement', { label: 'August' }))).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: demoDashboard.currentPeriod.label })).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('dashboard.groupStatistics.groupSumAllTime'))).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.paymentNoteSelf'))).toBeVisible();
  });
});
