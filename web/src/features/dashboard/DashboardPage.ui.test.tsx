import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRole, PlanningEvent } from '@/api/types';
import { demoDashboard, demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { DashboardPage } from './DashboardPage';

const mocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getPlanningSettings: vi.fn(),
  getTransactionSettings: vi.fn(),
  getCategories: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getDashboard: mocks.getDashboard,
    getPlanningSettings: mocks.getPlanningSettings,
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
    mocks.getPlanningSettings.mockResolvedValue({ enabled: true, version: 1, timeZone: 'Europe/Berlin' });
    mocks.getTransactionSettings.mockResolvedValue(transactionSettings);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, activeGroup: demoSession.groups[0], session: demoSession });
  });

  it('shows personal information, recent activity, and the signed group balance without category statistics', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('dashboard.recentActivities'))).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Lukas');
    const personalBalanceHeading = screen.getByRole('heading', { name: i18n.t('booking.openBalance') });
    expect(personalBalanceHeading).toBeVisible();
    expect(personalBalanceHeading.tagName).toBe('H2');
    expect(personalBalanceHeading.nextElementSibling?.querySelector('strong')).toHaveTextContent(/23,40/);
    expect(screen.getAllByText(i18n.t('booking.openBalance'))).toHaveLength(1);
    expect(screen.getByText(/23,40/, { selector: 'strong[data-financial-state="due"]' })).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.settlement', { label: 'August' }))).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.paymentNoteSelf'))).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.allActivities'))).toBeVisible();
    expect(screen.getByRole('heading', { name: i18n.t('dashboard.groupBalance.title') })).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.groupBalance.due'))).toBeVisible();
    expect(screen.getByText(/\+25,90/, { selector: 'div[data-financial-state="due"] strong' })).toBeVisible();
    expect(screen.queryByText('Getränke')).not.toBeInTheDocument();
    expect(screen.queryByText('Strafen')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: demoDashboard.currentPeriod.label })).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('booking.quickTitle'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('booking.submit') })).not.toBeInTheDocument();
    expect(mocks.getCategories).not.toHaveBeenCalled();
  });

  it('hides the self-payment action when the active membership has no effective permission', async () => {
    const activeGroup = {
      ...demoSession.groups[0],
      membership: { id: 'member-regular', roles: ['MEMBER'] as GroupRole[], groupPermissions: [] },
    };
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, groupOutstanding: undefined });
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: activeGroup.id, activeGroup, session: { ...demoSession, groups: [activeGroup] } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('dashboard.paymentNote'))).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('selfPayment.action') })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: i18n.t('dashboard.groupBalance.title') })).not.toBeInTheDocument();
  });

  it('renders the API-authorized group balance while local membership grants are stale', async () => {
    const activeGroup = {
      ...demoSession.groups[0],
      membership: { id: 'member-regular', roles: ['MEMBER'] as GroupRole[], groupPermissions: [], effectiveGrants: [] },
    };
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: activeGroup.id, activeGroup, session: { ...demoSession, groups: [activeGroup] } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: i18n.t('dashboard.groupBalance.title') })).toBeVisible();
    expect(screen.getByText(/\+25,90/, { selector: 'div[data-financial-state="due"] strong' })).toBeVisible();
  });

  it('formats the next planning event in the group time zone', async () => {
    const event: PlanningEvent = {
      id: 'planning-night-shift',
      version: 1,
      eventType: 'APPOINTMENT',
      status: 'PUBLISHED',
      title: 'Night shift',
      description: '',
      location: '',
      allDay: false,
      timeZone: 'Europe/Berlin',
      startsAt: '2026-08-31T22:30:00.000Z',
      waitlistEnabled: false,
      confirmationRevision: 1,
      audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] },
      participation: { invited: 1, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
      canEdit: false,
      canCancel: false,
      canRespond: false,
      canViewParticipants: false,
    };
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, planning: { event, actionRequired: false } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText('01.09.2026, 00:30')).toBeVisible();
    expect(mocks.getPlanningSettings).toHaveBeenCalledWith(demoSession.activeGroupId);
  });

  it('formats an all-day dashboard event without a midnight time', async () => {
    const event: PlanningEvent = {
      id: 'planning-weekend', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Team weekend', description: '', location: '', allDay: true, startDate: '2026-09-05', endDateExclusive: '2026-09-08', timeZone: 'Europe/Berlin', startsAt: '2026-09-04T22:00:00Z', endsAt: '2026-09-07T22:00:00Z', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 1, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false,
    };
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, planning: { event, actionRequired: false } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    const schedule = await screen.findByText('05.09.2026–07.09.2026 · Ganztägig');
    expect(schedule).toBeVisible();
    expect(screen.queryByText(/00:00/)).not.toBeInTheDocument();
    const openBalanceHeading = screen.getByRole('heading', { name: i18n.t('booking.openBalance') });
    const planningLink = screen.getByRole('link', { name: /Team weekend/ });
    expect(openBalanceHeading.compareDocumentPosition(planningLink) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const allActivitiesLink = screen.getByRole('link', { name: i18n.t('dashboard.allActivities') });
    expect(allActivitiesLink.compareDocumentPosition(planningLink) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('marks a negative open balance as credit in the member\'s favor', async () => {
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, openBalance: { minorUnits: '-250', currency: 'EUR' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(/-2,50/, { selector: 'strong[data-financial-state="credit"]' })).toBeVisible();
  });

  it('marks a zero open balance as balanced', async () => {
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, openBalance: { minorUnits: '0', currency: 'EUR' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(/^0,00/, { selector: 'strong[data-financial-state="balanced"]' })).toBeVisible();
  });

  it('removes period and category references while keeping the same group balance when settlements are disabled', async () => {
    mocks.getTransactionSettings.mockResolvedValue({ ...transactionSettings, settlementsEnabled: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: i18n.t('dashboard.groupBalance.title') })).toBeVisible();
    expect(screen.queryByText(i18n.t('dashboard.settlement', { label: 'August' }))).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: demoDashboard.currentPeriod.label })).not.toBeInTheDocument();
    expect(screen.getByText(/\+25,90/, { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText('Getränke')).not.toBeInTheDocument();
    expect(screen.queryByText('Strafen')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('dashboard.paymentNoteSelf'))).toBeVisible();
  });

  it.each([
    ['250', 'due', 'due', /^\+2,50/],
    ['0', 'balanced', 'balanced', /^0,00/],
    ['-250', 'credit', 'credit', /^-2,50/],
  ] as const)('renders group balance %s as %s', async (minorUnits, stateKey, financialState, amountPattern) => {
    mocks.getDashboard.mockResolvedValue({ ...demoDashboard, groupOutstanding: { minorUnits, currency: 'EUR' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    const stateLabel = i18n.t(`dashboard.groupBalance.${stateKey}`);
    expect(await screen.findByText(stateLabel)).toBeVisible();
    const card = screen.getByText(stateLabel).parentElement;
    expect(card).toHaveAttribute('data-financial-state', financialState);
    expect(card?.querySelector('strong')).toHaveTextContent(amountPattern);
  });
});
